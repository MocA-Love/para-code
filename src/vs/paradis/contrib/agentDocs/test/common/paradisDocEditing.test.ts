/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisDocAnchorFunctions, PARADIS_DOC_ANCHOR_FUNCTIONS } from '../../common/paradisDocCommentAnchor.js';
import { IParadisDocEditingHook, PARADIS_DOC_EDITING_SOURCE_MAX, paradisDocEditingActionOf, paradisDocEditingHead, paradisReadDocEditingMark } from '../../common/paradisDocEditing.js';

/** ページに埋める文字列そのものを動かす。 */
const fn: IParadisDocAnchorFunctions = new Function(`return ${PARADIS_DOC_ANCHOR_FUNCTIONS};`)();

function hook(event: string, extra: Partial<IParadisDocEditingHook> = {}): IParadisDocEditingHook {
	return { token: 'pane-1', event, ...extra };
}

function edit(event: string, input: Record<string, unknown>, extra: Partial<IParadisDocEditingHook> = {}): IParadisDocEditingHook {
	return hook(event, { toolName: 'Edit', toolUseId: 'toolu_1', payload: { tool_input: input }, ...extra });
}

suite('ParadisDocEditing', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('hooks become start, end and end-of-pane actions', () => {
		const doc = '/repo/docs/plan.md';
		assert.deepStrictEqual({
			edit: paradisDocEditingActionOf(edit('PreToolUse', { file_path: doc, old_string: '## 概要\n本文' }), 'claude'),
			write: paradisDocEditingActionOf(hook('PreToolUse', { toolName: 'Write', payload: { tool_input: { file_path: '/repo/index.html', content: '<p>x</p>' } } }), 'claude'),
			multiEdit: paradisDocEditingActionOf(hook('PreToolUse', { toolName: 'MultiEdit', payload: { tool_input: { file_path: doc, edits: [{ old_string: '一つ目', new_string: 'x' }] } } }), 'claude'),
			remote: paradisDocEditingActionOf(edit('PreToolUse', { file_path: doc, old_string: 'a' }, { remoteHostId: 'host-1' }), 'claude'),
			post: paradisDocEditingActionOf(edit('PostToolUse', { file_path: doc }), 'claude'),
			failure: paradisDocEditingActionOf(edit('PostToolUseFailure', { file_path: doc }), 'claude'),
			// 拒否の hook にツールの名前が無くても、ID で消す
			deniedWithoutName: paradisDocEditingActionOf(hook('PermissionDenied', { toolUseId: 'toolu_1' }), 'claude'),
			prompt: paradisDocEditingActionOf(hook('UserPromptSubmit'), 'claude'),
			stop: paradisDocEditingActionOf(hook('Stop'), 'claude'),
			exit: paradisDocEditingActionOf(hook('TerminalExit'), undefined),
		}, {
			edit: { type: 'start', hostId: '', path: doc, tool: 'edit', source: '## 概要\n本文', toolUseId: 'toolu_1' },
			write: { type: 'start', hostId: '', path: '/repo/index.html', tool: 'write' },
			multiEdit: { type: 'start', hostId: '', path: doc, tool: 'edit', source: '一つ目' },
			remote: { type: 'start', hostId: 'host-1', path: doc, tool: 'edit', source: 'a', toolUseId: 'toolu_1' },
			post: { type: 'end', hostId: '', path: doc, toolUseId: 'toolu_1' },
			failure: { type: 'end', hostId: '', path: doc, toolUseId: 'toolu_1' },
			deniedWithoutName: { type: 'end', toolUseId: 'toolu_1' },
			prompt: { type: 'endPane' },
			stop: { type: 'endPane' },
			exit: { type: 'endPane' },
		});
	});

	test('hooks that do not mark anything', () => {
		const doc = '/repo/docs/plan.md';
		assert.deepStrictEqual([
			// Codex のパッチは書く前の印を出さない（描き直しの差分の色だけ）
			paradisDocEditingActionOf(edit('PreToolUse', { file_path: doc, old_string: 'a' }), 'codex'),
			// ペインの持ち主と確かめられなかった hook
			paradisDocEditingActionOf(edit('PreToolUse', { file_path: doc, old_string: 'a' }, { ownerUnverified: true }), 'claude'),
			// 資料（html・md）でないファイル、相対パス、ほかのツール
			paradisDocEditingActionOf(edit('PreToolUse', { file_path: '/repo/src/a.ts', old_string: 'a' }), 'claude'),
			paradisDocEditingActionOf(edit('PreToolUse', { file_path: 'docs/plan.md', old_string: 'a' }), 'claude'),
			paradisDocEditingActionOf(hook('PreToolUse', { toolName: 'Bash', payload: { tool_input: { command: 'sed -i s/a/b/ /repo/docs/plan.md' } } }), 'claude'),
			paradisDocEditingActionOf(hook('PostToolUse', { toolName: 'Read', toolUseId: 'toolu_2', payload: { tool_input: { file_path: doc } } }), 'claude'),
			paradisDocEditingActionOf(hook('PermissionRequest', { toolName: 'Edit', payload: { tool_input: { file_path: doc } } }), 'claude'),
		], [undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
	});

	test('old_string: the last line is dropped when the hook may have cut it, and the head is capped at a line break', () => {
		const line = (i: number) => `<p>行 ${i} の文。<a href="./x.html">リンク</a></p>`;
		const lines = Array.from({ length: 400 }, (_, i) => line(i));
		// hook は文字列を 10,000 字で切る。タグの途中・リンクの途中で切れたもの
		const cutInTag = lines.join('\n').slice(0, 10_000);
		const source = paradisDocEditingHead(cutInTag)!;
		const sourceLines = source.split('\n');
		assert.deepStrictEqual({
			short: paradisDocEditingHead('<p>短い</p>'),
			blank: paradisDocEditingHead('  \n '),
			notText: paradisDocEditingHead(42),
			withinCap: source.length <= PARADIS_DOC_EDITING_SOURCE_MAX,
			endsOnWholeLine: sourceLines[sourceLines.length - 1] === line(sourceLines.length - 1),
			oneLongLine: paradisDocEditingHead('x'.repeat(10_000)),
		}, {
			short: '<p>短い</p>',
			blank: undefined,
			notText: undefined,
			withinCap: true,
			endsOnWholeLine: true,
			oneLongLine: undefined,
		});
	});

	test('a cut old_string locates only the lines that are in the rendered text', () => {
		const paragraphs = Array.from({ length: 400 }, (_, i) => `行 ${i} の文。リンク`);
		const rendered = fn.normalize(paragraphs.join(' '));
		const html = Array.from({ length: 400 }, (_, i) => `<p>行 ${i} の文。<a href="./x.html">リンク</a></p>`).join('\n');
		const source = paradisDocEditingHead(html.slice(0, 10_000))!;
		const located = fn.locate(rendered, source, 'html');
		const count = source.split('\n').length;
		assert.deepStrictEqual(located && { text: rendered.slice(located.start, located.end), match: located.match }, {
			text: fn.normalize(paragraphs.slice(0, count).join(' ')),
			match: 'exact',
		});
	});

	test('marks read from the channel are checked', () => {
		assert.deepStrictEqual([
			paradisReadDocEditingMark({ id: 'a-1', tool: 'edit', source: 'x', at: 1 }),
			paradisReadDocEditingMark({ id: 'a-1', tool: 'write', at: 1, source: '' }),
			paradisReadDocEditingMark({ id: 'a-1', tool: 'delete', at: 1 }),
			paradisReadDocEditingMark({ id: '<b>', tool: 'edit', at: 1 }),
			paradisReadDocEditingMark({ id: 'a-1', tool: 'edit', at: 1, source: 'x'.repeat(PARADIS_DOC_EDITING_SOURCE_MAX + 1) }),
			paradisReadDocEditingMark(undefined),
		], [
			{ id: 'a-1', tool: 'edit', source: 'x', at: 1 },
			{ id: 'a-1', tool: 'write', at: 1 },
			undefined,
			undefined,
			{ id: 'a-1', tool: 'edit', at: 1 },
			undefined,
		]);
	});
});
