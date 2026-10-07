/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { Event } from '../../../../../base/common/event.js';
import { ParadisCdpUpstream } from '../../../agentBrowser/node/paradisCdpUpstream.js';
import { paradisMobileBookmarksPayload } from '../../common/paradisMobileBookmarks.js';
import { paradisMobileBrowserPageMessage, paradisNormalizeMobileBrowserFocusReport } from '../../common/paradisMobileBrowserPageState.js';
import { paradisParseMobileBookmarks, paradisParseMobileBrowserFocus, paradisParseMobileBrowserInputRejected, paradisParseMobileBrowserPage } from '../../common/paradisMobileBrowserProtocol.js';
import { paradisMobileBrowserTargetsScope } from '../../common/paradisMobileBrowserScope.js';
import { paradisHasMobileCapability } from '../../common/paradisMobileCompat.js';
import { IParadisMobileAivisUsage, IParadisMobileVoiceUsage, paradisBuildMobileAivisUsage, paradisBuildMobileElevenLabsUsage, paradisMobileVoiceUsageFailure } from '../../common/paradisMobileVoiceUsage.js';
import { ParadisMobileBrowserMirror } from '../../node/paradisMobileBrowserMirror.js';
import type { MobileIdentity } from '../../common/paradisMobileCrypto.js';
import { Channels } from '../../common/paradisMobileProtocol.js';
import { IParadisMobileInboundFrame, ParadisMobileInboundFrameWire } from '../../common/paradisMobileRelay.js';
import { paradisAdvisorReplyMessage, paradisIsValidAgentInboundForTest } from '../../node/paradisMobileAgentChat.js';
import { ParadisAgentActivityTracker } from '../../node/paradisAgentActivity.js';
import { paradisNormalizeModCommandList } from '../../node/paradisAgentCommandCatalog.js';
import { newParseSignals, paradisParseClaudeTranscriptLineForTest, parseClaudeLine } from '../../../agentChat/common/paradisAgentTranscriptParser.js';
import { ParadisAgentWorkflowTracker, paradisParseWorkflowJournalLine, paradisParseWorkflowResultFile } from '../../../agentChat/common/paradisAgentWorkflows.js';
import { ParadisAgentTeamTracker } from '../../../agentChat/common/paradisAgentTeams.js';
import { ParadisAgentSessionStatusTracker } from '../../../agentChat/common/paradisAgentSessionStatus.js';
import { ParadisMobileOperationLedger } from '../../node/paradisMobileOperationLedger.js';
import { MobileSession, ParadisMobileRelayService } from '../../node/paradisMobileRelayService.js';
import { ParadisMobileTerminalRegistry } from '../../node/paradisMobileTerminalRegistry.js';

/**
 * PC ⇔ モバイルの公開ワイヤの固定形（ゴールデン、`app/protocol/test/golden/`）を PC 側から確かめる。
 *
 * - PC が組み立てる State が、ゴールデンと同じ形（項目名と値の型）であること
 * - アプリが送る形（State の要求・term の操作・agent の要求）を、PC が受け付けること
 *
 * アプリ側は `app/mobile/src/wireGolden.test.ts` が同じファイルを読み、逆向き（アプリが送る形と、
 * PC が送る形を受け付けること）を確かめる。形を変えたらゴールデンと両方のテストを同じ変更で直す。
 * app/ の vitest はこのリポジトリの CI で走らないので、PC 側のここが CI の歯止めになる。
 */

/** このテストのレイヤーでは `path` を import できないため、区切りは '/' に正規化して扱う。 */
function findRepositoryDirectory(relativePath: string): string | undefined {
	let directory = fileURLToPath(new URL('.', import.meta.url)).replace(/\\/g, '/');
	if (!directory.endsWith('/')) {
		directory += '/';
	}
	for (let depth = 0; depth < 12; depth++) {
		const candidate = `${directory}${relativePath}`;
		if (existsSync(candidate)) {
			return candidate;
		}
		const parent = directory.slice(0, directory.lastIndexOf('/', directory.length - 2) + 1);
		if (parent.length === 0 || parent === directory) {
			return undefined;
		}
		directory = parent;
	}
	return undefined;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** 値を「項目名と値の型」だけの形にする。配列は先頭の要素の形で代表させる（ゴールデンは先頭に全項目を持たせてある）。 */
function shapeOf(value: unknown): Json {
	if (Array.isArray(value)) {
		return value.length === 0 ? [] : [shapeOf(value[0])];
	}
	if (value === null) {
		return 'null';
	}
	if (typeof value === 'object') {
		const record = value as Record<string, unknown>;
		return Object.fromEntries(Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => [key, shapeOf(record[key])]));
	}
	return typeof value;
}

suite('ParadisMobileWireGolden', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let goldenRoot: string | undefined;
	suiteSetup(() => {
		goldenRoot = findRepositoryDirectory('app/protocol/test/golden');
	});

	function readGolden<T>(context: Mocha.Context, name: string): T {
		if (goldenRoot === undefined) {
			// リポジトリ外（配布物など）から実行された場合は照合対象が無い。
			context.skip();
		}
		return JSON.parse(readFileSync(`${goldenRoot}/${name}`, 'utf8')) as T;
	}

	test('PC が組み立てる State はゴールデンの current と同じ形', function () {
		const golden = readGolden<{ current: Record<string, unknown> }>(this, 'state.json');
		const registry = new ParadisMobileTerminalRegistry('golden-desktop-epoch');
		registry.syncWindow(1, 'window-session', 2, {
			activeWs: 'repo',
			workspaces: [{
				id: 'repo', name: 'para-code', color: '#0969da', branch: 'main', parent: 'parent',
				pr: { number: 135, state: 'open', url: 'https://github.com/example/para-code/pull/135' },
				note: { open: 2, done: 1 }, pinned: true,
			}],
			terminals: [{ terminalKey: 'terminal-key-1', id: 7, title: 'claude', ws: 'repo', agent: true, agentToken: 'agent-token-1', agentStatus: 'working', cols: 120, rows: 40 }],
			battery: { level: 80, charging: true },
			host: { kind: 'remote', id: 'ssh-remote+devbox', label: 'devbox', machineIdHash: 'a'.repeat(64) },
		});
		registry.setHostResources({ cpu: 25, memUsed: 8589934592, memTotal: 17179869184, diskFree: 107374182400, diskTotal: 494384795648 });
		registry.setPcName('MacBook-Pro');
		registry.setMachineIdHash('b'.repeat(64));
		registry.setDoNotDisturb({ enabled: true, until: 1_800_000_000_000 });
		const built = JSON.parse(JSON.stringify(registry.desktopState()));
		// 版・互換の窓・機能の広告・既存の能力の印は、形だけでなく値まで一致させる
		// （PC がこれらを変えたら、アプリの判定が変わるのでゴールデンも同じ変更で直す）。
		const pick = (state: Record<string, unknown>) => Object.fromEntries(['protocolVersion', 'minCompatibleMobile', 'capabilities', 'fsUploadEncoding', 'voiceClips'].map(key => [key, state[key]]));
		assert.deepStrictEqual({ shape: shapeOf(built), values: pick(built) }, { shape: shapeOf(golden.current), values: pick(golden.current) });
	});

	test('State の要求: 今のアプリは通り、版 3 のアプリ（W2-17 より前を含む）は通さない（mux の版 4）', function () {
		const golden = readGolden<{ current: object; preW217: object }>(this, 'state-request.json');
		const session = new MobileSession('mobile-a', new Uint8Array(16), new Uint8Array(32), {} as MobileIdentity, () => true, () => { }, undefined, new NullLogService());
		const negotiate = (request: object) => {
			const ok = session.negotiateProtocol(VSBuffer.fromString(JSON.stringify(request)).buffer);
			return { ok, termSync: paradisHasMobileCapability(session.capabilities, 'term.sync.v1'), advertised: session.capabilities !== undefined };
		};
		assert.deepStrictEqual({
			current: negotiate(golden.current),
			preW217: negotiate(golden.preW217),
			version3: negotiate({ ...golden.current, protocolVersion: 3, minCompatiblePc: 3 }),
			newerAppWithinWindow: negotiate({ ...golden.current, protocolVersion: 5, minCompatiblePc: 4 }),
			newerAppWithoutWindow: negotiate({ ...golden.preW217, protocolVersion: 5 }),
		}, {
			current: { ok: true, termSync: true, advertised: true },
			preW217: { ok: false, termSync: false, advertised: false },
			version3: { ok: false, termSync: false, advertised: false },
			newerAppWithinWindow: { ok: true, termSync: true, advertised: true },
			newerAppWithoutWindow: { ok: false, termSync: false, advertised: false },
		});
	});

	test('版が合わないアプリへは、断片に切らない版だけの案内を State の代わりに送る', async function () {
		const golden = readGolden<{ preW217: object }>(this, 'state-request.json');
		const sent: Uint8Array[] = [];
		const session = new MobileSession('mobile-a', new Uint8Array(16), new Uint8Array(32), {} as MobileIdentity, () => true, () => { }, undefined, new NullLogService());
		// 確立済みの mux の代わり（封緘は確かめない。送られたペイロードだけを見る）
		Object.assign(session, { mux: { send: async (_ch: string, payload: Uint8Array) => { sent.push(payload); }, dispose: () => { } } });
		session.negotiateProtocol(VSBuffer.fromString(JSON.stringify(golden.preW217)).buffer);
		const delivered = await session.sendDesktopState(new Uint8Array(64 * 1024), true);

		assert.deepStrictEqual({ delivered, guidance: sent.map(payload => JSON.parse(new TextDecoder().decode(payload))), small: sent.every(payload => payload.length <= 16 * 1024) }, {
			delivered: true,
			guidance: [{ protocolVersion: 4, minCompatibleMobile: 4 }],
			small: true,
		});
	});

	test('term: アプリが送る操作はすべて持ち主の PC 画面へ届く', async function () {
		const golden = readGolden<{ toPc: Array<Record<string, unknown>> }>(this, 'term.json');
		const registry = new ParadisMobileTerminalRegistry('golden-desktop-epoch');
		registry.syncWindow(1, 'window-session', 2, {
			activeWs: 'repo',
			workspaces: [{ id: 'repo', name: 'para-code' }],
			terminals: [{ terminalKey: 'terminal-key-1', id: 7, title: 'claude', ws: 'repo' }],
		});
		const delivered: ParadisMobileInboundFrameWire[] = [];
		const results: string[] = [];
		const terminalOperationTimers = new Map<string, ReturnType<typeof setTimeout>>();
		const service = Object.assign(Object.create(ParadisMobileRelayService.prototype) as object, {
			terminalRegistry: registry,
			terminalOperations: new ParadisMobileOperationLedger(),
			terminalOperationTimers,
			sessions: new Map([['mobile-a', { hasCurrentProtocol: true, sendFrame: async (_ch: string, _ws: undefined, payload: Uint8Array) => { results.push(new TextDecoder().decode(payload)); } }]]),
			logService: new NullLogService(),
			withCurrentRegisteredLease: async (_owner: unknown, task: () => Promise<boolean>) => task(),
			tryWithCurrentRegisteredLease: (_owner: unknown, _key: string, task: () => Promise<boolean>) => task(),
			_onInboundFrame: { fire: (frame: ParadisMobileInboundFrameWire) => delivered.push(frame) },
		}) as unknown as { handleTerminalFrame(frame: IParadisMobileInboundFrame): Promise<void> };
		try {
			for (const [index, message] of golden.toPc.entries()) {
				await service.handleTerminalFrame({ ch: Channels.Terminal, ws: undefined, seq: index + 1, payload: VSBuffer.fromString(JSON.stringify(message)), mobileId: 'mobile-a' });
			}
		} finally {
			for (const timer of terminalOperationTimers.values()) {
				clearTimeout(timer);
			}
		}
		assert.deepStrictEqual({
			delivered: delivered.map(frame => `${frame[1]} ${JSON.parse(frame[3].toString()).t}`),
			rejected: results,
		}, {
			delivered: golden.toPc.map(message => `window:1:2:window-session ${message.t}`),
			rejected: [],
		});
	});

	test('agent: アプリが送る要求はすべて PC の検査を通る', function () {
		const golden = readGolden<{ toPc: Array<{ t: string }> }>(this, 'agent.json');
		assert.deepStrictEqual(golden.toPc.map(message => [message.t, paradisIsValidAgentInboundForTest(message)]), golden.toPc.map(message => [message.t, true]));
	});

	test('agent: mod の一覧から PC が組み立てるコマンドの候補（agent.commands.v2）はゴールデンと同じ形', function () {
		type Message = Record<string, unknown>;
		const golden = readGolden<{ toMobile: Message[] }>(this, 'agent.json');
		const catalog = golden.toMobile.find(message => message.t === 'command-catalog') as { commands: Message[]; format: number };
		const listed = paradisNormalizeModCommandList([
			{ name: 'context', description: 'project dup of context', source: 'user' },
			{ name: 'codex:rescue', description: 'Delegate investigation to Codex', source: 'plugin', plugin: 'codex' },
			{ name: 'mcp__docs__summarize', description: 'Summarize a document', source: 'mcp' },
			{ name: '__remote-workflow', description: 'internal', source: 'builtin' },
			{ name: 'context', description: 'Visualize current context usage as a colored grid', source: 'builtin' },
		]);
		assert.deepStrictEqual({ commands: listed, format: catalog.format }, { commands: catalog.commands, format: 2 });
	});

	test('agent: PC が組み立てる Advisor の行・一覧の相談・平文の返答はゴールデンと同じ形', function () {
		type Message = Record<string, unknown>;
		const golden = readGolden<{ toMobile: Message[] }>(this, 'agent.json');
		const delta = golden.toMobile.find(message => message.t === 'delta') as { messages: Message[]; activity: { advisors: Message[] } };
		const detail = golden.toMobile.find(message => message.t === 'activity-detail') as { messages: Message[] };
		const line = (ts: number, block: unknown) => JSON.stringify({ type: 'assistant', timestamp: new Date(ts).toISOString(), advisorModel: 'claude-opus-5-5', message: { content: [block] } });
		const parsed = [
			...paradisParseClaudeTranscriptLineForTest(line(1760000002100, { type: 'server_tool_use', id: 'srvtoolu_golden1', name: 'advisor', input: {} })).messages,
			...paradisParseClaudeTranscriptLineForTest(line(1760000002900, { type: 'advisor_tool_result', tool_use_id: 'srvtoolu_golden1', content: { type: 'advisor_redacted_result', encrypted_content: 'x' } })).messages,
		];
		const tracker = new ParadisAgentActivityTracker();
		tracker.applyAdvisors([
			{ id: 'srvtoolu_golden0', model: 'claude-opus-5-5', status: 'failed', outcome: 'error', errorCode: 'too_many_requests', ownerId: 'agent-sub-1', startedAt: 1760000001000, updatedAt: 1760000001300 },
			{ id: 'srvtoolu_golden1', model: 'claude-opus-5-5', status: 'completed', outcome: 'redacted', startedAt: 1760000002100, updatedAt: 1760000002900 },
			{ id: 'srvtoolu_golden2', model: 'claude-opus-4-7', status: 'completed', outcome: 'text', text: '順番を入れ替えてください。', textTruncated: true, startedAt: 1760000002950, updatedAt: 1760000002990 },
		], 1760000002990);
		const reply = tracker.advisorReply('srvtoolu_golden2');
		assert.deepStrictEqual({
			messages: parsed,
			advisors: tracker.snapshot()?.advisors,
			reply: reply !== undefined ? paradisAdvisorReplyMessage(reply) : undefined,
		}, {
			messages: delta.messages.filter(message => message.advisor !== undefined).map(({ rev: _rev, ...message }) => message),
			advisors: delta.activity.advisors,
			reply: detail.messages[0],
		});
	});

	test('agent: PC が組み立てる Workflow の実行（agent.workflows.v1）はゴールデンと同じ', function () {
		type Message = Record<string, unknown>;
		const golden = readGolden<{ toMobile: Message[] }>(this, 'agent.json');
		const delta = golden.toMobile.find(message => message.t === 'delta' && message.workflows !== undefined) as { workflows: unknown[] };
		const signals = newParseSignals();
		const script = (name: string, description: string, phases: string) => `export const meta = {\n  name: '${name}',\n  description: '${description}',\n  phases: [${phases}],\n}\nphase('Find')`;
		const lines = [
			{ type: 'assistant', timestamp: new Date(1760000002900).toISOString(), message: { content: [{ type: 'tool_use', id: 'toolu_goldenwf1', name: 'Workflow', input: { script: script('security-audit', '2 つの観点で監査する', `{ title: 'Find', detail: '観点ごとに並列で探す' }, { title: 'Verify' }`) } }] } },
			{ type: 'user', timestamp: new Date(1760000003000).toISOString(), toolUseResult: { status: 'async_launched', taskId: 'wgolden1', taskType: 'local_workflow', workflowName: 'security-audit', runId: 'wf_golden-1', summary: '2 つの観点で監査する' }, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_goldenwf1', content: 'Workflow launched in background. Task ID: wgolden1' }] } },
			{ type: 'assistant', timestamp: new Date(1760000049900).toISOString(), message: { content: [{ type: 'tool_use', id: 'toolu_goldenwf2', name: 'Workflow', input: { script: script('quick-check', 'すぐ確かめる', `{ title: 'Find' }`) } }] } },
			{ type: 'user', timestamp: new Date(1760000050000).toISOString(), toolUseResult: { status: 'async_launched', taskId: 'wgolden2', taskType: 'local_workflow', workflowName: 'quick-check', runId: 'wf_golden-2', summary: 'すぐ確かめる' }, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_goldenwf2', content: 'Workflow launched in background. Task ID: wgolden2' }] } },
		];
		for (const line of lines) {
			parseClaudeLine(line, signals);
		}
		const tracker = new ParadisAgentWorkflowTracker();
		tracker.apply(signals.workflowSignals, signals.shellSignals);
		tracker.applyResult('wf_golden-1', paradisParseWorkflowResultFile({
			status: 'failed', workflowName: 'security-audit', startTime: 1760000003000, durationMs: 41000, timestamp: new Date(1760000044000).toISOString(),
			agentCount: 2, totalTokens: 4600000, totalToolCalls: 1703, error: 'Verify で 1 体が結果を返さず、台本が止まりました',
			phases: [{ title: 'Find', detail: '観点ごとに並列で探す' }, { title: 'Verify' }],
			workflowProgress: [
				{ type: 'workflow_agent', label: 'find:authz', phaseIndex: 1, agentId: 'agolden01', state: 'done', startedAt: 1760000003100, durationMs: 20000, tokens: 30000, toolCalls: 12, lastToolName: 'Read', cached: true },
				{ type: 'workflow_agent', label: 'verify:authz', phaseIndex: 2, agentId: 'agolden02', state: 'error', startedAt: 1760000024000, durationMs: 9000, tokens: 12000, toolCalls: 3 },
			],
		})!, 1760000044000);
		tracker.applyJournal('wf_golden-2', [paradisParseWorkflowJournalLine(`{"type":"started","key":"v2:${'0'.repeat(64)}","agentId":"agolden03","label":"find:ssrf","phase":"Find"}`)!]);
		assert.deepStrictEqual(tracker.snapshot(), delta.workflows);
	});

	test('agent: PC が組み立てる会話の状態（agent.session-status.v1）はゴールデンと同じ', function () {
		type Message = Record<string, unknown>;
		const golden = readGolden<{ toMobile: Message[] }>(this, 'agent.json');
		const delta = golden.toMobile.find(message => message.t === 'delta' && message.sessionStatus !== undefined) as { sessionStatus: unknown };
		const t0 = 1760000100000;
		const at = (seconds: number) => new Date(t0 + seconds * 1000).toISOString();
		const assistant = (id: string, seconds: number, input: number, read: number, creation: number, ttl: '5m' | '1h') => ({
			type: 'assistant', sessionId: 'golden-session', timestamp: at(seconds),
			message: { id, model: 'claude-opus-4-7', usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: creation, cache_creation: { ephemeral_5m_input_tokens: ttl === '5m' ? creation : 0, ephemeral_1h_input_tokens: ttl === '1h' ? creation : 0 } } },
		});
		const tracker = new ParadisAgentSessionStatusTracker('claude');
		for (const line of [
			assistant('msg_1', 0, 10, 0, 20000, '1h'),
			// 同じリクエストの別のブロック（1 回として数える）
			assistant('msg_1', 0, 10, 0, 20000, '1h'),
			assistant('msg_2', 60, 5, 20000, 500, '1h'),
			assistant('msg_3', 120, 3000, 0, 21000, '5m'),
			{ type: 'system', subtype: 'compact_boundary', sessionId: 'golden-session', timestamp: at(130) },
			assistant('msg_4', 140, 100, 2000, 5000, '5m'),
			assistant('msg_5', 200, 50, 7100, 100, '5m'),
		]) {
			tracker.observe(line);
		}
		tracker.applyMeasure({ tokens: 7250, window: 200000, percent: 4 });
		assert.deepStrictEqual(tracker.snapshot({ promptCache: { lastUsedAt: t0 + 190_000, ttlMs: 300_000 }, partial: true, model: 'claude-opus-4-7' }), delta.sessionStatus);
	});

	test('agent: PC が組み立てるチーム（agent.teams.v1）はゴールデンと同じ', function () {
		type Message = Record<string, unknown>;
		const golden = readGolden<{ toMobile: Message[] }>(this, 'agent.json');
		const delta = golden.toMobile.find(message => message.t === 'delta' && message.teams !== undefined) as { teams: unknown[] };
		const signals = newParseSignals();
		const at = (ms: number) => new Date(ms).toISOString();
		const spawned = (toolUseId: string, ms: number, result: Record<string, unknown>) => ({
			type: 'user', timestamp: at(ms), toolUseResult: { status: 'teammate_spawned', team_name: 'session-golden', is_splitpane: false, plan_mode_required: false, ...result },
			message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'Spawned successfully.' }] },
		});
		const received = (ms: number, tag: string) => ({ type: 'user', timestamp: at(ms), message: { content: `Another Claude session sent a message:\n${tag}\n\nThis came from another Claude session.` } });
		const lines = [
			{ type: 'assistant', timestamp: at(1760000070000), message: { content: [{ type: 'tool_use', id: 'toolu_goldenteam1', name: 'Agent', input: { description: '見出しを数える', name: 'counter', subagent_type: 'Explore', prompt: 'README の見出しを数えて' } }] } },
			{ type: 'assistant', timestamp: at(1760000070100), message: { content: [{ type: 'tool_use', id: 'toolu_goldenteam2', name: 'Agent', input: { description: 'テストを流す', name: 'tester', subagent_type: 'general-purpose', prompt: 'テストを流して' } }] } },
			spawned('toolu_goldenteam1', 1760000071000, { name: 'counter', agent_id: 'acounter-0123456789abcdef', color: 'blue', model: 'opus', resolvedModel: 'claude-opus-5-5', agent_type: 'Explore', tmux_pane_id: 'in-process' }),
			spawned('toolu_goldenteam2', 1760000071100, { name: 'tester', agent_id: 'atester-0123456789abcdef', color: 'yellow', model: 'sonnet', agent_type: 'general-purpose', tmux_pane_id: '%3', is_splitpane: true }),
			received(1760000080000, '<teammate-message teammate_id="counter" color="blue" summary="見出し数の報告">見出しは 12 個です。</teammate-message>'),
			received(1760000085000, '<teammate-message teammate_id="counter" color="blue">{"type":"plan_approval_request","from":"counter","planContent":"1. 読む\\n2. 数える","requestId":"r1"}</teammate-message>'),
			received(1760000090000, '<teammate-message teammate_id="tester" color="yellow">{"type":"idle_notification","from":"tester","idleReason":"available"}</teammate-message>'),
		];
		for (const line of lines) {
			parseClaudeLine(line, signals);
		}
		const tracker = new ParadisAgentTeamTracker();
		tracker.apply(signals.teamSignals);
		tracker.noteHook('active', { agentId: 'acounter-0123456789abcdef' }, 1760000086000, 'Bash npm test');
		assert.deepStrictEqual(tracker.snapshot(new Map([['acounter-0123456789abcdef', { id: 'approval-golden-1', tool: 'Bash' }]])), delta.teams);
	});

	test('browser: アプリが送る形を PC が受け、PC が組み立てる形はゴールデンと同じ形', async function () {
		type Message = Record<string, unknown>;
		const golden = readGolden<{ toPc: Message[]; toMobile: Message[]; bookmarks: { toPc: Message; toMobile: Message; push: Message } }>(this, 'browser.json');
		const state = readGolden<{ current: { renderers: { windowId: number }[]; workspaces: { sourceId: string }[] } }>(this, 'state.json');
		const logService = new NullLogService();
		const upstream = new ParadisCdpUpstream('', logService);
		(upstream as unknown as { fetchJson: () => Promise<unknown> }).fetchJson = async () => [
			{ id: 'target-1', type: 'page', title: 'Docs', url: 'https://example.com/docs' },
			{ id: 'target-other', type: 'page', title: 'Other', url: 'https://example.com/other' },
		];
		const asked: unknown[] = [];
		const mirror = new ParadisMobileBrowserMirror(upstream, undefined, { listBoundCdpTargets: async () => [{ token: 'pane-token-1', targetId: 'target-1' }], onDidAcknowledgePane: Event.None }, logService, {
			resolveSpaceTargetIds: async (windowId, ws) => { asked.push([windowId, ws]); return new Set(['target-1']); },
		});
		try {
			const replies: Message[] = [];
			await mirror.handleRequest('m', new TextEncoder().encode(JSON.stringify(golden.toPc[0])), payload => replies.push(JSON.parse(new TextDecoder().decode(payload))));

			// 入力の各種類が CDP の呼び出しになる（新しい種類を PC が受け付ける）
			const sentCdp: string[] = [];
			const session = {
				socket: { close: () => undefined, readyState: 1, send: (data: string) => sentCdp.push(JSON.parse(data).method) } as unknown as WebSocket,
				targetId: 'target-1', nextId: 1, viewWidth: 800, viewHeight: 600, captureTimer: undefined, captureInFlight: false, lastFrameData: undefined,
				handlers: new Map(), pushMode: true, pushStarted: false, lastPushFrameAt: Date.now(), lastMetricsAt: 0, binaryFrames: false,
				send: () => undefined, focusContextId: 1,
			};
			const internals = mirror as unknown as { sessions: Map<string, typeof session>; cdpCall: (target: typeof session, method: string, params: object, handler: (result: unknown) => void) => void };
			internals.sessions.set('m', session);
			internals.cdpCall = (_session, method, _params, handler) => handler(method === 'Runtime.evaluate' ? { result: { value: true } } : undefined);
			const inputKinds: [unknown, number][] = [];
			for (const message of golden.toPc.filter(candidate => candidate.t === 'input')) {
				const before = sentCdp.length;
				await mirror.handleRequest('m', new TextEncoder().encode(JSON.stringify(message)), () => undefined);
				inputKinds.push([message.kind, sentCdp.length - before]);
			}
			internals.sessions.delete('m');

			const pageMessage = paradisMobileBrowserPageMessage('target-1', { url: 'https://example.com/docs', title: 'Docs', loading: true, progress: 0.6, canGoBack: true, canGoForward: false });
			const focusMessage = paradisNormalizeMobileBrowserFocusReport(JSON.stringify({ focused: true, fieldId: 7, field: 'text', inputType: 'search', value: 'x'.repeat(5000), reason: 'tap' }), { targetId: 'target-1', seq: 3, now: 0, lastTapAt: 0 });
			const blurMessage = paradisNormalizeMobileBrowserFocusReport(JSON.stringify({ focused: false, reason: 'focus' }), { targetId: 'target-1', seq: 4, now: 0, lastTapAt: 0 });
			const bookmarksReply = {
				...paradisMobileBookmarksPayload([
					{ id: 'folder-1', type: 'folder', title: '仕事', icon: 'briefcase', color: '#2563eb', createdAt: 0, children: [{ id: 'bookmark-2', type: 'bookmark', title: 'Issues', url: 'https://example.com/issues', createdAt: 0 }] },
					{ id: 'bookmark-1', type: 'bookmark', title: 'Docs', url: 'https://example.com/docs', faviconHash: 'hash-1', createdAt: 0 },
				], hash => hash === 'hash-1' ? 'data:image/png;base64,iVBORw0KGgo=' : undefined), id: 'm-r-2'
			};
			const withoutId = (message: Message) => Object.fromEntries(Object.entries(message).filter(([key]) => key !== 'id'));

			assert.deepStrictEqual({
				scope: paradisMobileBrowserTargetsScope(golden.toPc[0]),
				asked,
				targets: replies.map(shapeOf),
				targetsValue: replies[0],
				inputKinds: inputKinds.map(([kind, calls]) => [kind, calls > 0]),
				page: shapeOf(pageMessage),
				focus: shapeOf(focusMessage),
				blur: shapeOf(blurMessage),
				bookmarks: bookmarksReply,
				parsed: [paradisParseMobileBrowserPage(golden.toMobile[1]), paradisParseMobileBrowserFocus(golden.toMobile[2]), paradisParseMobileBrowserFocus(golden.toMobile[3]), paradisParseMobileBookmarks(golden.bookmarks.toMobile), paradisParseMobileBrowserInputRejected(golden.toMobile[4])],
			}, {
				scope: { windowId: state.current.renderers[0].windowId, ws: state.current.workspaces[0].sourceId },
				asked: [[state.current.renderers[0].windowId, state.current.workspaces[0].sourceId]],
				targets: [shapeOf(golden.toMobile[0])],
				targetsValue: golden.toMobile[0],
				inputKinds: golden.toPc.filter(candidate => candidate.t === 'input').map(message => [message.kind, true]),
				page: shapeOf(golden.toMobile[1]),
				focus: shapeOf(golden.toMobile[2]),
				blur: shapeOf(golden.toMobile[3]),
				bookmarks: golden.bookmarks.toMobile,
				parsed: [golden.toMobile[1], golden.toMobile[2], golden.toMobile[3], withoutId(golden.bookmarks.toMobile), golden.toMobile[4]],
			});
		} finally {
			mirror.dispose();
		}
	});

	test('voiceUsage: PC が組み立てる読み上げの使用量はゴールデンと同じ形', function () {
		const golden = readGolden<{ current: Record<string, unknown>; failed: Record<string, unknown> }>(this, 'voice-usage.json');
		const at = 1791000000000;
		const aivis = paradisBuildMobileAivisUsage('0123456789ab', {
			days: [{ date: '2026-10-05', requestCount: 96, characterCount: 3920, creditConsumed: 0.5, byApiKey: { a: { name: 'para-code', requestCount: 96, characterCount: 3920, creditConsumed: 0.5 } } }],
			total: { requestCount: 96, characterCount: 3920, creditConsumed: 0.5 },
		}, { handle: null, name: null, creditBalance: 1000 }, { start: '2026-10-05', end: '2026-10-05' }, at);
		const elevenLabs = paradisBuildMobileElevenLabsUsage('ba9876543210', {
			days: [{ date: '2026-10-05', characterCount: 3920 }],
			totalCharacters: 3920,
			byModel: [{ key: 'eleven_v4_turbo', characterCount: 3920 }],
			byVoice: [{ key: 'voice-a', characterCount: 3920 }],
			recent: { days: 7, byModel: [{ key: 'eleven_v4_turbo', characterCount: 3920 }], byVoice: [{ key: 'voice-a', characterCount: 3920 }] },
		}, { kind: 'ok', subscription: { characterCount: 61540, characterLimit: 100000, nextResetAt: 1792540800000, tier: 'creator' } }, new Map([['eleven_v4_turbo', 'Eleven v4 Turbo']]), at);
		const current: IParadisMobileVoiceUsage = { fetchedAt: at, engine: 'elevenlabs', aivis, elevenLabs };
		const failed: IParadisMobileVoiceUsage = { fetchedAt: at, engine: 'aivis', aivis: paradisMobileVoiceUsageFailure<IParadisMobileAivisUsage>(undefined, '0123456789ab', 'Aivis API error 503', at) };
		assert.deepStrictEqual(
			{ current: shapeOf(JSON.parse(JSON.stringify(current))), failed: shapeOf(JSON.parse(JSON.stringify(failed))) },
			{ current: shapeOf(golden.current), failed: shapeOf(golden.failed) },
		);
	});
});
