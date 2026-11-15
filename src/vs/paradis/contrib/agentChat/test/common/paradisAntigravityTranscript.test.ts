/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { newParadisAntigravityParseState, paradisAntigravityQuestionInput, paradisAntigravityUserRequestText, parseAntigravityLine } from '../../common/paradisAntigravityTranscript.js';
import { IRawMessage, newParseSignals } from '../../common/paradisAgentTranscriptParser.js';

/** 自作の偽の会話（agy 1.5.9 の transcript_full.jsonl と同じキーと行の種類）。 */
const FAKE_TRANSCRIPT: readonly Record<string, unknown>[] = [
	{ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-16T01:00:00Z', content: '<USER_REQUEST>\nREADME を読んで\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is ...\n</ADDITIONAL_METADATA>' },
	{
		step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-16T01:00:01Z', model: 'gemini-3.8-flash-high',
		input_tokens: 100, cache_read_tokens: 0, output_tokens: 10, thinking: 'まず一覧を見る',
		tool_calls: [{ name: 'run_command', args: { CommandLine: 'ls', WaitMsBeforeAsync: 0, toolSummary: 'list' } }, { name: 'read_file', args: { Path: '/repo/README.md' } }],
	},
	{ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-16T01:00:02Z', content: 'Command exited with code 0.\n\nCommand output:\nREADME.md' },
	{ step_index: 3, source: 'MODEL', type: 'GENERIC', status: 'ERROR', created_at: '2026-11-16T01:00:03Z', content: '', error: 'file not found' },
	{
		step_index: 4, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-16T01:00:04Z', model: 'gemini-3.8-flash-high',
		input_tokens: 120, cache_read_tokens: 0, output_tokens: 12,
		tool_calls: [{ name: 'ask_question', args: { questions: [{ question: 'どちらにしますか', options: ['A', 'B'], is_multi_select: false }] } }],
	},
	{ step_index: 5, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-16T01:00:05Z', content: 'User answered: A' },
	{ step_index: 6, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-16T01:00:06Z', model: 'gemini-3.8-pro-low', input_tokens: 130, cache_read_tokens: 0, output_tokens: 20, content: 'A にしました' },
	{ step_index: 7, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', created_at: '2026-11-16T01:00:07Z', error: 'quota exceeded' },
	{ step_index: 8, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: '2026-11-16T01:00:08Z', content: '<SYSTEM_MESSAGE>子の会話の指示</SYSTEM_MESSAGE>' },
	{ step_index: 9, source: 'SYSTEM', type: 'CHECKPOINT', status: 'DONE', created_at: '2026-11-16T01:00:09Z', input_tokens: 0, cache_read_tokens: 0, output_tokens: 0, content: '要約' },
];

suite('paradisAntigravityTranscript', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('turns the steps of a conversation into messages, and ties each tool result to its call in order', () => {
		const signals = newParseSignals();
		const state = newParadisAntigravityParseState();
		const messages: IRawMessage[] = FAKE_TRANSCRIPT.flatMap(line => parseAntigravityLine(line, signals, state));
		const at = (second: number) => Date.parse(`2026-11-16T01:00:0${second}Z`);
		assert.deepStrictEqual({ messages, model: signals.model, userText: signals.userText }, {
			messages: [
				{ role: 'user', kind: 'text', text: 'README を読んで', ts: at(0) },
				{ role: 'assistant', kind: 'thinking', text: 'まず一覧を見る', ts: at(1) },
				{ role: 'assistant', kind: 'tool_use', tool: 'run_command', text: '{"CommandLine":"ls","WaitMsBeforeAsync":0,"toolSummary":"list"}', ts: at(1), toolUseId: 'agy-1-0' },
				{ role: 'assistant', kind: 'tool_use', tool: 'read_file', text: '{"Path":"/repo/README.md"}', ts: at(1), toolUseId: 'agy-1-1' },
				{ role: 'tool', kind: 'tool_result', text: 'Command exited with code 0.\n\nCommand output:\nREADME.md', ts: at(2), toolUseId: 'agy-1-0' },
				{ role: 'tool', kind: 'tool_result', text: 'file not found', ts: at(3), toolUseId: 'agy-1-1', isError: true },
				{ role: 'assistant', kind: 'question', text: 'どちらにしますか', ts: at(4), options: [{ label: 'A' }, { label: 'B' }], toolUseId: 'agy-4-0', questionIndex: 0, questionCount: 1, questionGroup: 'agy-4-0' },
				{ role: 'tool', kind: 'tool_result', text: 'User answered: A', ts: at(5), toolUseId: 'agy-4-0' },
				{ role: 'assistant', kind: 'text', text: 'A にしました', ts: at(6) },
				{ role: 'assistant', kind: 'text', text: 'quota exceeded', ts: at(7), isError: true },
			],
			model: 'gemini-3.8-pro-low',
			userText: true,
		});
	});

	test('reads a tool result without its call (the start of a read window) as an unlinked result', () => {
		const messages = parseAntigravityLine(FAKE_TRANSCRIPT[2], newParseSignals(), newParadisAntigravityParseState());
		assert.deepStrictEqual(messages.map(message => ({ kind: message.kind, toolUseId: message.toolUseId })), [{ kind: 'tool_result', toolUseId: undefined }]);
	});

	test('takes only the request out of the wrapped user input, and converts ask_question into the AskUserQuestion shape', () => {
		assert.deepStrictEqual({
			wrapped: paradisAntigravityUserRequestText('<USER_REQUEST>\n直して\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>'),
			unwrapped: paradisAntigravityUserRequestText('そのまま<USER_SETTINGS_CHANGE>y</USER_SETTINGS_CHANGE>'),
			question: paradisAntigravityQuestionInput({ questions: [{ question: '選んで', options: ['はい', '', 'いいえ'], is_multi_select: true }, { options: ['x'] }] }),
			notQuestion: paradisAntigravityQuestionInput({ questions: 'none' }),
		}, {
			wrapped: '直して',
			unwrapped: 'そのまま',
			question: { questions: [{ question: '選んで', options: [{ label: 'はい' }, { label: 'いいえ' }], multiSelect: true }] },
			notQuestion: undefined,
		});
	});
});
