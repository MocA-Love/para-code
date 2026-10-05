/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseAskUserQuestions, paradisBackgroundTaskLaunch, paradisParseClaudeTranscriptBatchesForTest, paradisParseClaudeTranscriptLineForTest, paradisParseCodexDetailLinesForTest, paradisParseCodexRolloutForTest, paradisParseCodexTranscriptLineForTest } from '../../common/paradisAgentTranscriptParser.js';
import { paradisAgentQuestionHasPreview } from '../../common/paradisAgentChat.js';
import { paradisCodexUserAuthoredContent, paradisIsCodexInjectedText } from '../../common/paradisCodexInjectedContext.js';
import { CODEX_FIXTURE_CHILD_ROLLOUT, CODEX_FIXTURE_ENCRYPTED, CODEX_FIXTURE_EXEC, CODEX_FIXTURE_PARENT_ROLLOUT, CODEX_FIXTURE_USER_MESSAGES } from './paradisCodexRolloutFixture.js';

suite('paradisAgentTranscriptParser', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads background launches of subagents, Workflows and Bash with their kind (Claude Code 2.1 results)', () => {
		assert.deepStrictEqual([
			paradisBackgroundTaskLaunch('Async agent launched successfully.\nagentId: a26518e457e28a0b2 (internal ID)', { isAsync: true, status: 'async_launched', agentId: 'a26518e457e28a0b2' }),
			paradisBackgroundTaskLaunch('Workflow launched in background. Task ID: wtt5a7mts\nSummary: x', { status: 'async_launched', taskId: 'wtt5a7mts', taskType: 'local_workflow', runId: 'wf_c9889fa1-754' }),
			paradisBackgroundTaskLaunch('Workflow launched in background. Task ID: wgq21crt0', undefined),
			paradisBackgroundTaskLaunch('Command running in the background with ID: bsn1ipvue. Output is being written to: /tmp/x', undefined),
			paradisBackgroundTaskLaunch('done', { stdout: 'x' }),
		], [
			{ id: 'a26518e457e28a0b2', kind: 'agent' },
			{ id: 'wtt5a7mts', kind: 'workflow', runId: 'wf_c9889fa1-754' },
			{ id: 'wgq21crt0', kind: 'workflow' },
			{ id: 'bsn1ipvue', kind: 'shell' },
			undefined,
		]);
	});

	test('AskUserQuestion の選択肢の preview を運び（空文字も「ある」）、4,000 文字で切る。preview を描くのは単一選択の質問だけ', () => {
		const long = 'x'.repeat(4_100);
		const messages = parseAskUserQuestions({
			questions: [
				{ question: 'Q1', header: 'H1', options: [{ label: 'A', description: 'a', preview: '# A' }, { label: 'B', preview: '' }, { label: 'C', preview: long }] },
				{ question: 'Q2', multiSelect: true, options: [{ label: 'D', preview: '# D' }, { label: 'E' }] },
				{ question: 'Q3', options: [{ label: 'F' }] },
			],
		}, 'toolu_1', 1);
		assert.deepStrictEqual({
			options: messages[0].options?.map(option => ({ ...option, preview: option.preview?.length === 4_001 ? 'cut' : option.preview })),
			hasPreview: messages.map(message => paradisAgentQuestionHasPreview(message)),
		}, {
			options: [{ label: 'A', description: 'a', preview: '# A' }, { label: 'B', preview: '' }, { label: 'C', preview: 'cut' }],
			hasPreview: [true, false, false],
		});
	});

	test('does not show the Codex interruption notice as a user message', () => {
		const userMessage = (text: string) => JSON.stringify({ type: 'response_item', timestamp: '2026-09-27T10:00:00.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
		// codex-cli 0.155.1 が rollout に書く中断の知らせ（フェーズ6の実機確認 NG-11）
		const aborted = paradisParseCodexTranscriptLineForTest(userMessage('<turn_aborted>\nThe user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>'));
		const normal = paradisParseCodexTranscriptLineForTest(userMessage('P6CXASK 質問して'));
		assert.deepStrictEqual({ aborted: aborted.messages.length, normal: normal.messages.map(message => message.text) }, { aborted: 0, normal: ['P6CXASK 質問して'] });
	});

	test('shows a slash command and the output of allowed commands written as system rows (Claude Code 2.1.289), with secrets masked', () => {
		const system = (content: string) => JSON.stringify({ type: 'system', subtype: 'local_command', content, timestamp: '2026-10-04T09:00:00.000Z' });
		const command = (name: string) => system(`<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args></command-args>`);
		const stdout = (text: string) => system(`<local-command-stdout>${text}</local-command-stdout>`);
		const shown = (messages: ReturnType<typeof paradisParseClaudeTranscriptBatchesForTest>) => messages.map(message => [message.role, message.text, message.notice === true, message.noticeSource]);
		assert.deepStrictEqual({
			context: shown(paradisParseClaudeTranscriptBatchesForTest([[command('context')], [stdout(' \u001b[1mContext Usage\u001b[22m\n\u001b[38;5;244m⛁ ⛁ ⛀ \u001b[39m  Haiku 4.5\n⛶ ⛶   ⛁ Messages: 7.6k tokens')]])),
			empty: shown(paradisParseClaudeTranscriptBatchesForTest([[command('compact'), stdout('')]])),
			status: shown(paradisParseClaudeTranscriptBatchesForTest([[command('status'), stdout('Account: someone@example.com')]])),
			mcp: shown(paradisParseClaudeTranscriptBatchesForTest([[command('mcp'), stdout('github: https://user:secret@example.com')]])),
			noCommand: shown(paradisParseClaudeTranscriptBatchesForTest([[stdout('orphan output')]])),
			masked: shown(paradisParseClaudeTranscriptBatchesForTest([[command('usage'), stdout('token ghp_abcdefghijklmnopqrstuvwxyz0123456789 and https://user:pass@example.com/repo')]])),
			userRow: shown(paradisParseClaudeTranscriptBatchesForTest([[
				JSON.stringify({ type: 'user', timestamp: '2026-10-04T09:00:00.000Z', message: { role: 'user', content: '<command-name>/reload-skills</command-name>' } }),
				JSON.stringify({ type: 'user', timestamp: '2026-10-04T09:00:00.000Z', message: { role: 'user', content: '<local-command-stdout>Reloaded skills: 229 skills available</local-command-stdout>' } }),
			]])),
		}, {
			context: [['user', '/context', false, undefined], ['assistant', 'Context Usage\nHaiku 4.5\nMessages: 7.6k tokens', true, 'command']],
			// /compact は区切り線（compact_boundary）が実行を表すので、実行記録の吹き出しも出さない
			empty: [],
			status: [['user', '/status', false, undefined]],
			mcp: [['user', '/mcp', false, undefined]],
			noCommand: [],
			masked: [['user', '/usage', false, undefined], ['assistant', 'token *** and https://***@example.com/repo', true, 'command']],
			userRow: [['user', '/reload-skills', false, undefined], ['assistant', 'Reloaded skills: 229 skills available', true, 'command']],
		});
	});

	test('picks up the "Unknown command" row without showing it', () => {
		const parsed = paradisParseClaudeTranscriptLineForTest(JSON.stringify({ type: 'system', subtype: 'informational', content: 'Unknown command: /nonexistent', timestamp: '2026-10-04T09:00:00.000Z' }));
		assert.deepStrictEqual({ messages: parsed.messages, unknown: parsed.unknownSlashCommands }, {
			messages: [],
			unknown: [{ name: 'nonexistent', ts: Date.parse('2026-10-04T09:00:00.000Z') }],
		});
	});

	test('shows a manual /compact as one divider with the tokens and a folded summary, without the two /compact bubbles (Claude Code 2.1.289)', () => {
		const at = '2026-10-04T09:00:00.000Z';
		const user = (content: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'user', timestamp: at, message: { role: 'user', content }, ...extra });
		const summary = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request and Intent:\n${'x'.repeat(700)}`;
		const lines = [
			user('/compact'),
			JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', timestamp: at, compactMetadata: { trigger: 'manual', preTokens: 846988, postTokens: 9720 } }),
			user(summary, { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
			user('<local-command-caveat>The command below was run directly in Claude Code</local-command-caveat>', { isMeta: true }),
			user('<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>'),
			user('<local-command-stdout>\u001b[2mCompacted (ctrl+o to see full summary)\u001b[22m</local-command-stdout>'),
		];
		const messages = paradisParseClaudeTranscriptBatchesForTest([lines]);
		const body = summary.replace(/^This session[^\n]*\n+Summary:\n+/, '');
		assert.deepStrictEqual(messages.map(message => ({ role: message.role, text: message.noticeSource === 'compact-summary' ? message.text.slice(0, 40) : message.text, notice: message.notice, source: message.noticeSource, compaction: message.compaction, truncated: message.truncated, full: message.fullText?.length })), [
			{ role: 'assistant', text: 'コンテキストを圧縮しました（手動） 846,988 → 9,720 トークン', notice: true, source: 'compaction', compaction: { trigger: 'manual', tokensBefore: 846988, tokensAfter: 9720 }, truncated: undefined, full: undefined },
			{ role: 'assistant', text: body.slice(0, 40), notice: true, source: 'compact-summary', compaction: { summaryChars: body.length }, truncated: true, full: body.length },
		]);
	});

	test('shows an automatic compaction without tokens when the metadata has none, and keeps a failed /compact output', () => {
		const at = '2026-10-04T09:00:00.000Z';
		const command = JSON.stringify({ type: 'system', subtype: 'local_command', timestamp: at, content: '<command-name>/compact</command-name>\n            <command-args></command-args>' });
		const failed = JSON.stringify({ type: 'system', subtype: 'local_command', timestamp: at, content: '<local-command-stdout>Error: Not enough messages to compact.</local-command-stdout>' });
		assert.deepStrictEqual({
			auto: paradisParseClaudeTranscriptLineForTest(JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: at, compactMetadata: { trigger: 'auto' } })).messages.map(message => [message.text, message.compaction]),
			failed: paradisParseClaudeTranscriptBatchesForTest([[command, failed]]).map(message => [message.text, message.noticeSource]),
		}, {
			auto: [['コンテキストを圧縮しました（自動）', { trigger: 'auto' }]],
			failed: [['Error: Not enough messages to compact.', 'command']],
		});
	});

	test('turns /config model=<alias> into a notice of the result instead of a /config bubble (Claude Code 2.1.289)', () => {
		const at = '2026-10-04T11:46:29.049Z';
		const system = (content: string) => JSON.stringify({ type: 'system', subtype: 'local_command', content, level: 'info', timestamp: at, isMeta: false });
		const config = (args: string) => system(`<command-name>/config</command-name>\n            <command-message>config</command-message>\n            <command-args>${args}</command-args>`);
		const stdout = (text: string) => system(`<local-command-stdout>${text}</local-command-stdout>`);
		const shown = (lines: string[]) => paradisParseClaudeTranscriptBatchesForTest([lines]).map(message => [message.role, message.text, message.notice === true]);
		assert.deepStrictEqual({
			set: shown([config('model=sonnet'), stdout('Set Model to sonnet')]),
			refused: shown([config('model=claude-sonnet-5-5'), stdout('Model takes one of: default, sonnet, opus. For a specific model ID, use /model.')]),
			other: shown([config('theme=dark'), stdout('Set Theme to dark')]),
		}, {
			set: [['assistant', 'モデルを sonnet に変えました', true]],
			refused: [['assistant', 'モデルを変えられませんでした（Model takes one of: default, sonnet, opus. For a specific model ID, use /model.）', true]],
			other: [['user', '/config theme=dark', false]],
		});
	});

	test('shows a Codex compaction as a divider from the compacted row only', () => {
		const lines = [
			JSON.stringify({ timestamp: '2026-08-10T11:32:07.617Z', type: 'compacted', payload: { message: '', replacement_history: [], window_number: 1 } }),
			JSON.stringify({ timestamp: '2026-08-10T11:32:07.624Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'ContextCompaction', id: 'c1' }, started_at_ms: 1786361454704, completed_at_ms: 1786361527624 } }),
		];
		assert.deepStrictEqual(paradisParseCodexRolloutForTest(lines).messages.map(message => [message.text, message.notice, message.noticeSource, message.ts]), [
			['コンテキストを圧縮しました', true, 'compaction', Date.parse('2026-08-10T11:32:07.617Z')],
		]);
	});

	test('shows a prompt queued while Claude Code is working as a user message', () => {
		const queued = (prompt: unknown, commandMode = 'prompt', extra: Record<string, unknown> = { origin: { kind: 'human' }, humanTurn: true }) => paradisParseClaudeTranscriptLineForTest(JSON.stringify({
			type: 'attachment', timestamp: '2026-10-01T10:00:00.000Z',
			attachment: { type: 'queued_command', commandMode, prompt, ...extra },
		}));
		const summarize = (result: ReturnType<typeof queued>) => ({ userText: result.userText, messages: result.messages.map(message => ({ role: message.role, kind: message.kind, text: message.text, ts: message.ts, images: message.imageData?.length ?? 0 })) });
		const ts = Date.parse('2026-10-01T10:00:00.000Z');
		assert.deepStrictEqual({
			text: summarize(queued('次はテストも直して')),
			blocks: summarize(queued([{ type: 'text', text: 'この画面を見て' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }])),
			notification: summarize(queued('<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n</task-notification>')),
			notificationBlocks: summarize(queued([{ type: 'text', text: '<task-notification>\n<task-id>abc</task-id>\n</task-notification>' }])),
			otherMode: summarize(queued('/compact', 'bash')),
			peer: summarize(queued('<cross-session-message>\n調査が終わりました\n</cross-session-message>', 'prompt', { origin: { kind: 'peer' } })),
			agentMessage: summarize(queued('<agent-message from="worker">報告です</agent-message>', 'prompt', { origin: { kind: 'peer' } })),
			meta: summarize(queued('内部の指示', 'prompt', { origin: { kind: 'human' }, isMeta: true })),
			noOrigin: summarize(queued('出どころ不明', 'prompt', {})),
			attachmentTime: summarize(queued('届いた時刻で並べる', 'prompt', { origin: { kind: 'human' }, timestamp: '2026-10-01T10:00:05.000Z' })),
		}, {
			text: { userText: true, messages: [{ role: 'user', kind: 'text', text: '次はテストも直して', ts, images: 0 }] },
			blocks: { userText: true, messages: [{ role: 'user', kind: 'text', text: 'この画面を見て', ts, images: 1 }] },
			notification: { userText: false, messages: [] },
			notificationBlocks: { userText: false, messages: [] },
			otherMode: { userText: false, messages: [] },
			peer: { userText: false, messages: [] },
			agentMessage: { userText: false, messages: [] },
			meta: { userText: false, messages: [] },
			noOrigin: { userText: false, messages: [] },
			attachmentTime: { userText: true, messages: [{ role: 'user', kind: 'text', text: '届いた時刻で並べる', ts: ts + 5_000, images: 0 }] },
		});
	});

	test('does not repeat a queued prompt that Claude Code rewrites as a user line after Esc', () => {
		const at = (second: number) => `2026-10-01T10:00:${String(second).padStart(2, '0')}.000Z`;
		const queued = (text: string, second: number) => JSON.stringify({ type: 'attachment', timestamp: at(second), attachment: { type: 'queued_command', commandMode: 'prompt', prompt: text, origin: { kind: 'human' } } });
		const user = (text: string, second: number) => JSON.stringify({ type: 'user', timestamp: at(second), message: { role: 'user', content: text } });
		const assistant = (text: string, second: number) => JSON.stringify({ type: 'assistant', timestamp: at(second), message: { role: 'assistant', content: [{ type: 'text', text }] } });
		const texts = (batches: string[][]) => paradisParseClaudeTranscriptBatchesForTest(batches).map(message => `${message.role}:${message.text}`);
		assert.deepStrictEqual({
			// queued_command → 割り込み → 同じ本文の user 行（読み取りの塊をまたいでも同じ）
			rewritten: texts([[queued('テストも直して', 1)], [user('[Request interrupted by user]', 2)], [user('テストも直して', 3)]]),
			// 割り込みが無ければ、後から同じ本文を送り直したものは別の発言として出す
			resent: texts([[queued('テストも直して', 1), assistant('直しました', 2), user('テストも直して', 3)]]),
			// 割り込みの後にエージェントが応答したら、控えは捨てる
			answeredAfterInterrupt: texts([[queued('テストも直して', 1), user('[Request interrupted by user]', 2), assistant('止めました', 3), user('テストも直して', 4)]]),
			// 応答の後に Esc で止めて同じ文を打ち直したものは、書き直しではなく新しい発言
			retypedAfterAnswer: texts([[queued('続けて', 1), assistant('進めます', 2), user('[Request interrupted by user for tool use]', 3), user('続けて', 4)]]),
		}, {
			rewritten: ['user:テストも直して'],
			resent: ['user:テストも直して', 'assistant:直しました', 'user:テストも直して'],
			answeredAfterInterrupt: ['user:テストも直して', 'assistant:止めました', 'user:テストも直して'],
			retypedAfterAnswer: ['user:続けて', 'assistant:進めます', 'user:続けて'],
		});
	});

	test('attaches the structured subagent id to the Agent result even when the text is cut', () => {
		const result = (blocks: unknown[]) => paradisParseClaudeTranscriptLineForTest(JSON.stringify({ type: 'user', timestamp: '2026-10-01T10:00:00.000Z', toolUseResult: { status: 'completed', agentId: 'a1b2c3' }, message: { role: 'user', content: blocks } })).messages.map(message => ({ toolUseId: message.toolUseId, agentId: message.agentId, truncated: message.truncated }));
		assert.deepStrictEqual({
			single: result([{ type: 'tool_result', tool_use_id: 'toolu_a', content: `${'報告'.repeat(2_000)}\nagentId: a1b2c3` }]),
			// 構造化した結果は行に 1 つなので、tool_result が 2 つある行ではどちらにも付けない
			two: result([{ type: 'tool_result', tool_use_id: 'toolu_b', content: 'one' }, { type: 'tool_result', tool_use_id: 'toolu_c', content: 'two' }]),
		}, {
			single: [{ toolUseId: 'toolu_a', agentId: 'a1b2c3', truncated: true }],
			two: [{ toolUseId: 'toolu_b', agentId: undefined, truncated: undefined }, { toolUseId: 'toolu_c', agentId: undefined, truncated: undefined }],
		});
	});

	test('turns the Advisor server tool into a marked call and result instead of dropping it', () => {
		const line = (content: unknown) => paradisParseClaudeTranscriptLineForTest(JSON.stringify({ type: 'assistant', timestamp: '2026-10-04T10:42:08.000Z', advisorModel: 'claude-opus-5-5', message: { id: 'msg_1', role: 'assistant', content: [content] } })).messages
			.map(message => ({ kind: message.kind, tool: message.tool, text: message.text, toolUseId: message.toolUseId, isError: message.isError, advisor: message.advisor }));
		assert.deepStrictEqual({
			call: line({ type: 'server_tool_use', id: 'srvtoolu_1', name: 'advisor', input: {} }),
			redacted: line({ type: 'advisor_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'advisor_redacted_result', encrypted_content: 'EsQe...' } }),
			plain: line({ type: 'advisor_tool_result', tool_use_id: 'srvtoolu_2', content: { type: 'advisor_result', text: '順番を入れ替えてください。' } }),
			error: line({ type: 'advisor_tool_result', tool_use_id: 'srvtoolu_3', content: { type: 'advisor_tool_result_error', error_code: 'too_many_requests' } }),
			otherServerTool: line({ type: 'server_tool_use', id: 'srvtoolu_4', name: 'web_fetch', input: {} }),
		}, {
			call: [{ kind: 'tool_use', tool: 'Advisor', text: 'claude-opus-5-5', toolUseId: 'srvtoolu_1', isError: undefined, advisor: { model: 'claude-opus-5-5' } }],
			redacted: [{ kind: 'tool_result', tool: undefined, text: '返答は暗号化されているため、表示できません。', toolUseId: 'srvtoolu_1', isError: undefined, advisor: { model: 'claude-opus-5-5', outcome: 'redacted' } }],
			plain: [{ kind: 'tool_result', tool: undefined, text: '順番を入れ替えてください。', toolUseId: 'srvtoolu_2', isError: undefined, advisor: { model: 'claude-opus-5-5', outcome: 'text' } }],
			error: [{ kind: 'tool_result', tool: undefined, text: 'too_many_requests', toolUseId: 'srvtoolu_3', isError: true, advisor: { model: 'claude-opus-5-5', outcome: 'error', errorCode: 'too_many_requests' } }],
			otherServerTool: [],
		});
	});

	test('unwraps pasted_content written by Claude Code 2.1.278+', () => {
		const user = (content: unknown) => paradisParseClaudeTranscriptLineForTest(JSON.stringify({ type: 'user', timestamp: '2026-10-01T10:00:00.000Z', message: { role: 'user', content } })).messages.map(message => message.text);
		assert.deepStrictEqual({
			withId: user('\n\n<pasted_content id="512f">\n一行目\n二行目\n</pasted_content id="512f">\n'),
			withoutId: user('\n\n<pasted_content>\n貼った本文\n</pasted_content>\n'),
			surrounded: user('これを見て\n\n<pasted_content id="a1">\nlog line\n</pasted_content id="a1">\nどう思う?'),
			literalTag: user('タグの書き方は <pasted_content id="x">本文</pasted_content id="x"> です'),
			nested: user('\n\n<pasted_content id="outer">\n前\n\n<pasted_content id="inner">\n中\n</pasted_content id="inner">\n後\n</pasted_content id="outer">\n'),
			mismatchedId: user('\n\n<pasted_content id="a">\n本文\n</pasted_content id="b">\n'),
			blocks: user([{ type: 'text', text: '\n\n<pasted_content id="9">\n配列の本文\n</pasted_content id="9">\n' }]),
		}, {
			withId: ['一行目\n二行目'],
			withoutId: ['<pasted_content>\n貼った本文\n</pasted_content>'],
			surrounded: ['これを見て\nlog line\nどう思う?'],
			literalTag: ['タグの書き方は <pasted_content id="x">本文</pasted_content id="x"> です'],
			nested: ['前\n\n<pasted_content id="inner">\n中\n</pasted_content id="inner">\n後'],
			mismatchedId: ['<pasted_content id="a">\n本文\n</pasted_content id="b">'],
			blocks: ['配列の本文'],
		});
	});

	test('drops every kind of Codex injected context and keeps what the user wrote', () => {
		const texts = (lines: Readonly<Record<string, string>>) => Object.fromEntries(Object.entries(lines).map(([name, row]) => [name, paradisParseCodexTranscriptLineForTest(row).messages.map(message => ({ text: message.text, images: message.imageData?.length ?? 0 }))]));
		assert.deepStrictEqual({ injected: texts(CODEX_FIXTURE_USER_MESSAGES.injected), authored: texts(CODEX_FIXTURE_USER_MESSAGES.authored) }, {
			injected: { agentsMdGlobalWithKinds: [], agentsMdGlobalLegacy: [], agentsMdProjectLegacy: [], recommendedPluginsLegacy: [], recommendedPluginsWithKinds: [], goalInternalLegacy: [], skillLegacy: [], appsOpenPageWithKinds: [], turnAborted: [] },
			authored: {
				textWithKinds: [{ text: '設定画面の不具合を直して', images: 0 }],
				imageWithKinds: [{ text: '<image name=[Image #1]>\n[image]\n</image>\nこの画面を見て', images: 1 }],
				taskLegacy: [{ text: '<task>\nリポジトリ /workspace/app の実装計画をレビューしてください\n</task>', images: 0 }],
			},
		});
	});

	test('prefers content_item_kinds over the text and only keeps the parts the user wrote', () => {
		const payload = (kinds: readonly string[] | undefined) => ({
			type: 'message', role: 'user',
			content: [{ type: 'input_text', text: '# AGENTS.md instructions\n\n<INSTRUCTIONS>\nx\n</INSTRUCTIONS>' }, { type: 'input_text', text: '本文' }],
			...(kinds !== undefined ? { internal_chat_message_metadata_passthrough: { content_item_kinds: kinds } } : {}),
		});
		assert.deepStrictEqual({
			mixed: paradisCodexUserAuthoredContent(payload(['agents_md.instructions', 'user.text'])),
			// 将来 `user.` の素性が増えても発言として扱う
			futureUserKind: paradisCodexUserAuthoredContent(payload(['agents_md.instructions', 'user.audio_transcript'])),
			allInjected: paradisCodexUserAuthoredContent(payload(['agents_md.instructions', 'environments.environment_context'])),
			// 素性の数が content と合わない（壊れた）ときは本文の先頭で判定する
			brokenKinds: paradisCodexUserAuthoredContent(payload(['user.text'])),
			noKinds: paradisCodexUserAuthoredContent(payload(undefined)),
			text: ['# AGENTS.md instructions', '# AGENTS.md instructions for /w', '<recommended_plugins>', '  <skill>', '# AGENTS.md instructionsX', '<skills>', 'AGENTS.md を読んで', '<task>'].map(paradisIsCodexInjectedText),
		}, {
			mixed: [{ type: 'input_text', text: '本文' }],
			futureUserKind: [{ type: 'input_text', text: '本文' }],
			allInjected: undefined,
			brokenKinds: undefined,
			noKinds: undefined,
			text: [true, true, true, true, false, false, false, false],
		});
	});

	test('reads sub-agents, their final answers, the goal, the plan and a failed turn from a paginated Codex rollout', () => {
		const parsed = paradisParseCodexRolloutForTest(CODEX_FIXTURE_PARENT_ROLLOUT);
		assert.deepStrictEqual({
			messages: parsed.messages.map(message => ({ role: message.role, kind: message.kind, tool: message.tool, text: message.text, toolUseId: message.toolUseId, isError: message.isError })),
			timeline: parsed.timeline,
			turnEnded: parsed.turnEnded,
		}, {
			messages: [
				{ role: 'user', kind: 'text', tool: undefined, text: '設定画面の不具合を直して', toolUseId: undefined, isError: undefined },
				{ role: 'assistant', kind: 'tool_use', tool: 'Agent', text: 'reviewer (gpt-5.5 high)', toolUseId: 'call_spawn1', isError: undefined },
				{ role: 'tool', kind: 'tool_result', tool: undefined, text: '起動しました: /root/reviewer', toolUseId: 'call_spawn1', isError: undefined },
				{ role: 'assistant', kind: 'tool_use', tool: 'send_message', text: '{"target":"reviewer"}', toolUseId: 'call_send1', isError: undefined },
				{ role: 'tool', kind: 'tool_result', tool: undefined, text: 'サブエージェント完了: reviewer\nレビューの結果、問題は 2 件です。', toolUseId: 'codex-final:amsg_2', isError: undefined },
				{ role: 'assistant', kind: 'tool_use', tool: 'update_plan', text: '{"explanation":"順に進めます","plan":[{"step":"原因を調べる","status":"completed"},{"step":"直す","status":"in_progress"},{"step":"テストを足す","status":"pending"}]}', toolUseId: 'call_plan1', isError: undefined },
				{ role: 'assistant', kind: 'text', tool: undefined, text: 'You\'ve hit your usage limit. Try again later.', toolUseId: undefined, isError: true },
			],
			timeline: [
				{ type: 'turnStart', at: Date.parse('2026-10-01T21:34:03.074Z') },
				{ type: 'subagent', id: 'thread-child', agentPath: '/root/reviewer', kind: 'started', at: 1790890475402, callId: 'call_spawn1' },
				{ type: 'subagent', id: 'thread-child', agentPath: '/root/reviewer', kind: 'interacted', at: 1790890570020, via: 'send_message', callId: 'call_send1' },
				{ type: 'subagent', id: 'thread-child', agentPath: '/root/reviewer', kind: 'completed', at: 1790890753317 },
				{ type: 'goal', threadId: 'thread-root', objective: '設定画面の不具合を直してテストまで通す', status: 'active', tokensUsed: 0, timeUsedSeconds: 0, at: Date.parse('2026-10-01T21:40:00.000Z') },
				{ type: 'plan', steps: [{ step: '原因を調べる', status: 'completed' }, { step: '直す', status: 'in_progress' }, { step: 'テストを足す', status: 'pending' }], explanation: '順に進めます', at: Date.parse('2026-10-01T21:40:05.000Z') },
				{ type: 'turnEnd', reason: 'failed', at: Date.parse('2026-10-01T21:45:00.000Z') },
			],
			turnEnded: 'failed',
		});
	});

	test('shows a Codex child rollout without the injected instructions or its exchanges with the parent', () => {
		const parsed = paradisParseCodexRolloutForTest(CODEX_FIXTURE_CHILD_ROLLOUT);
		assert.deepStrictEqual({
			detail: paradisParseCodexDetailLinesForTest(CODEX_FIXTURE_CHILD_ROLLOUT).map(message => `${message.role}:${message.tool ?? message.kind}:${message.text}`),
			subagents: parsed.timeline.filter(event => event.type === 'subagent').length,
			turnEnded: parsed.turnEnded,
		}, {
			detail: ['assistant:send_message:{"target":"/root"}', 'assistant:text:レビューの結果、問題は 2 件です。'],
			subagents: 0,
			turnEnded: 'completed',
		});
	});

	test('reads Codex exec results written as an input_text array in the parent chat and in a sub-agent', () => {
		const parent = paradisParseCodexRolloutForTest([CODEX_FIXTURE_EXEC.parentCall, CODEX_FIXTURE_EXEC.parentOutput, CODEX_FIXTURE_EXEC.functionOutputArray, CODEX_FIXTURE_EXEC.legacyString]);
		assert.deepStrictEqual({
			parent: parent.messages.map(message => ({ role: message.role, kind: message.kind, text: message.text, toolUseId: message.toolUseId })),
			child: paradisParseCodexDetailLinesForTest([...CODEX_FIXTURE_CHILD_ROLLOUT, CODEX_FIXTURE_EXEC.childCall, CODEX_FIXTURE_EXEC.childOutput]).map(message => `${message.role}:${message.tool ?? message.kind}:${message.text}`),
		}, {
			parent: [
				{ role: 'assistant', kind: 'tool_use', text: 'text(await tools.exec_command({cmd:"ls"}));\n', toolUseId: 'call_exec_parent' },
				{ role: 'tool', kind: 'tool_result', text: 'Script completed\nWall time 0.3 seconds\nOutput:\n{"exit_code":0,"output":"README.md\\nsrc\\n"}', toolUseId: 'call_exec_parent' },
				{ role: 'tool', kind: 'tool_result', text: 'Script failed\nWall time 0.0 seconds\nOutput:\nScript error:\nexec cell 6 not found', toolUseId: 'call_wait' },
				{ role: 'tool', kind: 'tool_result', text: 'Script running with cell ID 6\nWall time 31.0 seconds\nOutput:\n', toolUseId: 'call_exec_legacy' },
			],
			child: [
				'assistant:send_message:{"target":"/root"}',
				'assistant:text:レビューの結果、問題は 2 件です。',
				'assistant:exec:text(await tools.exec_command({cmd:"git status"}));\n',
				'tool:tool:Script completed\nWall time 0.1 seconds\nOutput:\nOn branch main',
			],
		});
	});

	test('joins the parts of a Codex array result with a newline unless the previous part ends with one, and keeps an image-only result', () => {
		const parsed = paradisParseCodexRolloutForTest([CODEX_FIXTURE_EXEC.mcpOutput, CODEX_FIXTURE_EXEC.imageOnly]);
		assert.deepStrictEqual(parsed.messages.map(message => ({ text: message.text, toolUseId: message.toolUseId, images: message.imageData?.length })), [
			{ text: '{"title":"Issue 1"}\n{"title":"Issue 2"}', toolUseId: 'call_mcp', images: undefined },
			{ text: '[image]', toolUseId: 'call_image', images: 1 },
		]);
	});

	test('never shows a Codex encrypted payload in a multi-agent tool call', () => {
		const call = (name: string, args: string) => JSON.stringify({ timestamp: '2026-10-01T21:34:35.275Z', type: 'response_item', payload: { type: 'function_call', name, arguments: args, call_id: `call_${name}` } });
		const texts = [
			// task_name が無く、指示が暗号化されている spawn_agent
			call('spawn_agent', JSON.stringify({ message: CODEX_FIXTURE_ENCRYPTED, fork_turns: 'none' })),
			// JSON として読めない引数
			call('send_message', `{"target":"a","message":"${CODEX_FIXTURE_ENCRYPTED}"`),
			// 入れ子の値の中
			call('followup_task', JSON.stringify({ target: 'a', items: [{ text: CODEX_FIXTURE_ENCRYPTED }] })),
			call('send_message', JSON.stringify({ target: 'a', message: CODEX_FIXTURE_ENCRYPTED })),
		].flatMap(line => paradisParseCodexTranscriptLineForTest(line).messages.map(message => message.text));
		assert.deepStrictEqual({ leaked: texts.filter(text => text.includes('gAAAAA')), texts }, {
			leaked: [],
			texts: ['{"fork_turns":"none"}', '{"target":"a","message":"[encrypted]"', '{"target":"a","items":[{"text":"[encrypted]"}]}', '{"target":"a"}'],
		});
	});

	test('keeps a user shell command in the chat and turns a legacy subagent notification into a result card', () => {
		const user = (text: string) => JSON.stringify({ timestamp: '2026-10-01T21:34:35.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
		const shell = paradisParseCodexTranscriptLineForTest(user('<user_shell_command>\n<command>ls</command>\n<result>a.txt</result>\n</user_shell_command>')).messages;
		const notification = paradisParseCodexTranscriptLineForTest(user('<subagent_notification>\n{"agent_path":"/root/reviewer","status":{"completed":"問題は 2 件です"}}\n</subagent_notification>')).messages;
		const errored = paradisParseCodexTranscriptLineForTest(user('<subagent_notification>\n{"agent_path":"/root/reviewer","status":{"errored":"stream disconnected"}}\n</subagent_notification>')).messages;
		const shutdown = paradisParseCodexTranscriptLineForTest(user('<subagent_notification>\n{"agent_path":"/root/reviewer","status":"shutdown"}\n</subagent_notification>')).messages;
		assert.deepStrictEqual({
			shell: shell.map(message => [message.role, message.kind, message.text]),
			notification: notification.map(message => [message.role, message.kind, message.text, message.toolUseId?.startsWith('codex-final:')]),
			errored: errored.map(message => [message.text, message.isError]),
			shutdown: shutdown.map(message => [message.text, message.isError]),
			title: paradisIsCodexInjectedText('<user_shell_command>\nls\n</user_shell_command>'),
		}, {
			shell: [['user', 'text', '<user_shell_command>\n<command>ls</command>\n<result>a.txt</result>\n</user_shell_command>']],
			notification: [['tool', 'tool_result', 'サブエージェント完了: reviewer\n問題は 2 件です', true]],
			errored: [['サブエージェント失敗: reviewer\nstream disconnected', true]],
			shutdown: [['サブエージェント終了: reviewer', undefined]],
			title: true,
		});
	});
});
