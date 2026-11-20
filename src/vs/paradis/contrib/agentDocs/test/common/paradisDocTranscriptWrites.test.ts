/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ParadisAgentKind } from '../../../agentChat/common/paradisAgentDescriptor.js';
import { IParadisDocTranscriptWrite, ParadisDocTranscriptWriteReader } from '../../common/paradisDocTranscriptWrites.js';

// 行の形は手元の記録を写したもの（Claude Code 2.1.329・Codex 0.169.1・Antigravity CLI 1.5.12。パス・ID は伏せ、
// 書き込みの判定に使わない欄は削った）。

const SESSION = '11111111-2222-4333-8444-555555555555';

function claudeUse(id: string, name: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		parentUuid: 'p', isSidechain: false, type: 'assistant', uuid: `u-${id}`, timestamp: '2026-01-01T00:00:00.000Z', sessionId: SESSION, cwd: '/repo', version: '2.1.329',
		message: { id: `m-${id}`, type: 'message', role: 'assistant', model: 'claude', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' },
		...extra,
	};
}

function claudeResult(id: string, timestamp: string, isError = false, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		parentUuid: `u-${id}`, isSidechain: false, type: 'user', uuid: `r-${id}`, timestamp, sessionId: SESSION, cwd: '/repo', version: '2.1.329',
		message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: isError ? 'Error: denied' : '', is_error: isError }] },
		...(isError ? {} : { toolUseResult: { type: 'create', filePath: '/repo/x', content: '', structuredPatch: [], originalFile: null, userModified: false } }),
		...extra,
	};
}

function codexItem(timestamp: string, payload: Record<string, unknown>): Record<string, unknown> {
	return { timestamp, type: 'response_item', payload };
}

function read(agent: ParadisAgentKind, lines: readonly Record<string, unknown>[]): IParadisDocTranscriptWrite[] {
	const reader = new ParadisDocTranscriptWriteReader(agent);
	return lines.flatMap(line => reader.read(line));
}

suite('paradisDocTranscriptWrites', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('Claude Code: a write is returned when its result arrives without an error (also for calls made from the REPL)', () => {
		// REPL の中から呼んだ Write は、呼び出しも結果も isVirtual の付いた行になる（model は "<synthetic>"）
		const virtual = { isVirtual: true, madeBy: 'other' };
		assert.deepStrictEqual(read('claude', [
			claudeUse('toolu_write', 'Write', { file_path: '/repo/report.html', content: '<h1>x</h1>' }),
			claudeResult('toolu_write', '2026-01-01T00:00:01.000Z'),
			claudeUse('toolu_edit', 'Edit', { file_path: '/repo/notes.md', old_string: 'a', new_string: 'b' }),
			claudeResult('toolu_edit', '2026-01-01T00:00:02.000Z'),
			claudeUse('toolu_virtual', 'Write', { file_path: '/repo/from-repl.html', content: 'x' }, virtual),
			claudeResult('toolu_virtual', '2026-01-01T00:00:03.000Z', false, { ...virtual, turnCompanion: true }),
			claudeUse('toolu_nb', 'NotebookEdit', { notebook_path: '/repo/nb.md', new_source: 'x' }),
			claudeResult('toolu_nb', '2026-01-01T00:00:04.000Z'),
			// 失敗・断られた書き込み、結果の来ていない書き込み、資料でないファイル、ほかのツール、相対パス
			claudeUse('toolu_denied', 'Write', { file_path: '/repo/denied.md', content: 'x' }),
			claudeResult('toolu_denied', '2026-01-01T00:00:05.000Z', true),
			claudeUse('toolu_pending', 'Write', { file_path: '/repo/pending.md', content: 'x' }),
			claudeUse('toolu_ts', 'Write', { file_path: '/repo/main.ts', content: 'x' }),
			claudeResult('toolu_ts', '2026-01-01T00:00:06.000Z'),
			claudeUse('toolu_bash', 'Bash', { command: 'echo x > /repo/bash.md' }),
			claudeResult('toolu_bash', '2026-01-01T00:00:07.000Z'),
			claudeUse('toolu_rel', 'Write', { file_path: 'relative.md', content: 'x' }),
			claudeResult('toolu_rel', '2026-01-01T00:00:08.000Z'),
			// 同じ結果の行がもう一度来ても 2 回にしない
			claudeResult('toolu_write', '2026-01-01T00:00:09.000Z'),
			{ type: 'progress', data: { type: 'hook_progress' }, timestamp: '2026-01-01T00:00:10.000Z' },
		]), [
			{ path: '/repo/report.html', tool: 'Write', toolUseId: 'toolu_write', at: Date.parse('2026-01-01T00:00:01.000Z'), cwd: '/repo' },
			{ path: '/repo/notes.md', tool: 'Edit', toolUseId: 'toolu_edit', at: Date.parse('2026-01-01T00:00:02.000Z'), cwd: '/repo' },
			{ path: '/repo/from-repl.html', tool: 'Write', toolUseId: 'toolu_virtual', at: Date.parse('2026-01-01T00:00:03.000Z'), cwd: '/repo' },
			{ path: '/repo/nb.md', tool: 'NotebookEdit', toolUseId: 'toolu_nb', at: Date.parse('2026-01-01T00:00:04.000Z'), cwd: '/repo' },
		]);
	});

	test('Codex: apply_patch as a tool call and inside an exec script, with paths relative to the cwd of the turn', () => {
		const patch = (file: string, kind = 'Add') => `*** Begin Patch\n*** ${kind} File: ${file}\n+x\n*** End Patch`;
		assert.deepStrictEqual(read('codex', [
			{ timestamp: '2026-01-01T00:00:00.000Z', type: 'session_meta', payload: { id: SESSION, cwd: '/repo', originator: 'codex_cli_rs' } },
			codexItem('2026-01-01T00:00:01.000Z', { type: 'custom_tool_call', status: 'completed', call_id: 'call_1', name: 'apply_patch', input: patch('docs/one.md') }),
			codexItem('2026-01-01T00:00:02.000Z', { type: 'custom_tool_call_output', call_id: 'call_1', output: 'Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\nA docs/one.md\n' }),
			// 作業ディレクトリが変わった後のターン
			{ timestamp: '2026-01-01T00:00:03.000Z', type: 'turn_context', payload: { turn_id: 't2', cwd: '/repo/sub', model: 'gpt' } },
			// コードを書いて実行する形。スクリプトの中の tools.apply_patch("…") がパッチ（結果の文に一覧は無い）
			codexItem('2026-01-01T00:00:04.000Z', { type: 'custom_tool_call', status: 'completed', call_id: 'call_2', name: 'exec', input: `text(await tools.exec_command({cmd:"ls"}));\ntext(await tools.apply_patch(${JSON.stringify(patch('two.html', 'Update'))}));\nawait tools.apply_patch(${JSON.stringify(patch('/abs/three.md'))});` }),
			codexItem('2026-01-01T00:00:05.000Z', { type: 'custom_tool_call_output', call_id: 'call_2', output: [{ type: 'input_text', text: 'Script completed\nWall time 1.1 seconds\nOutput:\n' }, { type: 'input_text', text: 'ok' }] }),
			// 失敗したパッチ・失敗したスクリプト・パッチの無いスクリプト・資料でないファイル
			codexItem('2026-01-01T00:00:06.000Z', { type: 'custom_tool_call', call_id: 'call_3', name: 'apply_patch', input: patch('failed.md') }),
			codexItem('2026-01-01T00:00:07.000Z', { type: 'custom_tool_call_output', call_id: 'call_3', output: 'Exit code: 1\nOutput:\nerror' }),
			codexItem('2026-01-01T00:00:08.000Z', { type: 'custom_tool_call', call_id: 'call_4', name: 'exec', input: `await tools.apply_patch(${JSON.stringify(patch('script-failed.md'))});` }),
			codexItem('2026-01-01T00:00:09.000Z', { type: 'custom_tool_call_output', call_id: 'call_4', output: [{ type: 'input_text', text: 'Script failed\nWall time 0.1 seconds\nOutput:\n' }] }),
			codexItem('2026-01-01T00:00:10.000Z', { type: 'custom_tool_call', call_id: 'call_5', name: 'exec', input: 'text(await tools.exec_command({cmd:"echo x > shell.md"}));' }),
			codexItem('2026-01-01T00:00:11.000Z', { type: 'custom_tool_call_output', call_id: 'call_5', output: [{ type: 'input_text', text: 'Script completed\n' }] }),
			codexItem('2026-01-01T00:00:12.000Z', { type: 'custom_tool_call', call_id: 'call_6', name: 'apply_patch', input: patch('src/main.ts') }),
			codexItem('2026-01-01T00:00:13.000Z', { type: 'custom_tool_call_output', call_id: 'call_6', output: 'Exit code: 0\nOutput:\nSuccess. Updated the following files:\nA src/main.ts\n' }),
		]), [
			{ path: '/repo/docs/one.md', tool: 'apply_patch', toolUseId: 'call_1', at: Date.parse('2026-01-01T00:00:02.000Z'), cwd: '/repo' },
			{ path: '/repo/sub/two.html', tool: 'apply_patch', toolUseId: 'call_2', at: Date.parse('2026-01-01T00:00:05.000Z'), cwd: '/repo/sub' },
			{ path: '/abs/three.md', tool: 'apply_patch', toolUseId: 'call_2', at: Date.parse('2026-01-01T00:00:05.000Z'), cwd: '/repo/sub' },
		]);
	});

	test('Antigravity CLI: write_file and edit_file are matched to the results that follow in the same order', () => {
		const planner = (step: number, calls: readonly Record<string, unknown>[]) => ({ step_index: step, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-01-01T00:00:00Z', content: '', tool_calls: calls });
		const result = (step: number, createdAt: string, extra: Record<string, unknown> = {}) => ({ step_index: step, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: createdAt, content: 'ok', ...extra });
		assert.deepStrictEqual(read('antigravity', [
			{ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-01-01T00:00:00Z', content: '<USER_REQUEST>\nx\n</USER_REQUEST>' },
			planner(1, [
				{ name: 'read_file', args: { Path: '/repo/README.md' } },
				{ name: 'write_file', args: { Path: '/repo/report.html', Content: '<h1>x</h1>', Overwrite: true } },
				{ name: 'edit_file', args: { Path: '/repo/notes.md', Target: 'a', Replacement: 'b' } },
				{ name: 'write_file', args: { Path: '/repo/failed.md', Content: 'x' } },
			]),
			result(2, '2026-01-01T00:00:01Z'),
			result(3, '2026-01-01T00:00:02Z'),
			result(4, '2026-01-01T00:00:03Z'),
			result(5, '2026-01-01T00:00:04Z', { status: 'ERROR', error: 'denied' }),
			// 結果の来ないまま次のターンが始まった呼び出しは持ち越さない
			planner(6, [{ name: 'write_file', args: { Path: '/repo/stale.md', Content: 'x' } }]),
			{ step_index: 7, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-01-01T00:00:05Z', content: 'y' },
			result(8, '2026-01-01T00:00:06Z'),
		]), [
			{ path: '/repo/report.html', tool: 'write_file', at: Date.parse('2026-01-01T00:00:02Z') },
			{ path: '/repo/notes.md', tool: 'edit_file', at: Date.parse('2026-01-01T00:00:03Z') },
		]);
	});
});
