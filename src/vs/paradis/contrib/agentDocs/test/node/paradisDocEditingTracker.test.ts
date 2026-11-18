/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IParadisAgentHookEvent } from '../../../agentBrowser/node/paradisAgentHookBus.js';
import { IParadisDocEditingChange } from '../../common/paradisDocEditing.js';
import { ParadisDocEditingChannel, ParadisDocEditingTracker } from '../../node/paradisDocEditingTracker.js';

const DOC = '/repo/docs/plan.md';

function hook(token: string, event: string, extra: Partial<IParadisAgentHookEvent> = {}): IParadisAgentHookEvent {
	return { token, event, sessionId: 's-1', transcriptPath: '/home/u/.claude/projects/x/s-1.jsonl', cwd: '/repo', at: 1000, ...extra };
}

function edit(token: string, event: string, toolUseId: string | undefined, path = DOC): IParadisAgentHookEvent {
	return hook(token, event, { toolName: 'Edit', ...(toolUseId !== undefined ? { toolUseId } : {}), payload: { tool_input: { file_path: path, old_string: '## 概要' } } });
}

suite('ParadisDocEditingTracker', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const store = disposables.add(new DisposableStore());
		const hooks = store.add(new Emitter<IParadisAgentHookEvent>());
		const turnEnded = store.add(new Emitter<{ token: string }>());
		const awaiting = store.add(new Emitter<{ token: string }>());
		const timers: { callback: () => void; disposed: boolean }[] = [];
		const tracker = store.add(new ParadisDocEditingTracker(hooks.event, turnEnded.event, awaiting.event, callback => {
			const timer = { callback, disposed: false };
			timers.push(timer);
			return toDisposable(() => timer.disposed = true);
		}));
		const changes: string[] = [];
		store.add(tracker.onDidChange((change: IParadisDocEditingChange) => changes.push(`${change.path}:${change.mark ? change.mark.tool : 'cleared'}`)));
		const shown = () => tracker.get('', DOC) ? tracker.get('', DOC)!.tool : undefined;
		return { hooks, turnEnded, awaiting, timers, tracker, changes, shown };
	}

	test('a mark is shown on PreToolUse and cleared on each of its ends', () => {
		const t = setup();
		const results: Record<string, unknown> = {};
		const run = (name: string, end: () => void) => {
			t.hooks.fire(edit('pane-1', 'PreToolUse', 'toolu_1'));
			const before = t.shown();
			end();
			results[name] = [before, t.shown()];
		};
		run('post', () => t.hooks.fire(edit('pane-1', 'PostToolUse', 'toolu_1')));
		run('failure', () => t.hooks.fire(edit('pane-1', 'PostToolUseFailure', 'toolu_1')));
		run('denied', () => t.hooks.fire(hook('pane-1', 'PermissionDenied', { toolUseId: 'toolu_1' })));
		run('nextPrompt', () => t.hooks.fire(hook('pane-1', 'UserPromptSubmit')));
		run('stop', () => t.hooks.fire(hook('pane-1', 'Stop')));
		run('turnEnded', () => t.turnEnded.fire({ token: 'pane-1' }));
		run('awaitingUser', () => t.awaiting.fire({ token: 'pane-1' }));
		run('paneExit', () => t.hooks.fire(hook('pane-1', 'TerminalExit', { sessionId: undefined, transcriptPath: undefined })));
		run('timeout', () => t.timers[t.timers.length - 1].callback());
		assert.deepStrictEqual(results, {
			post: ['edit', undefined],
			failure: ['edit', undefined],
			denied: ['edit', undefined],
			nextPrompt: ['edit', undefined],
			stop: ['edit', undefined],
			turnEnded: ['edit', undefined],
			awaitingUser: ['edit', undefined],
			paneExit: ['edit', undefined],
			timeout: ['edit', undefined],
		});
		// 消えた印の時間切れは止めてある
		assert.deepStrictEqual(t.timers.map(timer => timer.disposed), [true, true, true, true, true, true, true, true, true]);
	});

	test('ends of other tools and other panes leave the mark', () => {
		const t = setup();
		t.hooks.fire(edit('pane-1', 'PreToolUse', 'toolu_1'));
		t.hooks.fire(edit('pane-1', 'PostToolUse', 'toolu_other'));
		t.hooks.fire(hook('pane-2', 'Stop'));
		t.turnEnded.fire({ token: 'pane-2' });
		t.hooks.fire(hook('pane-1', 'PreToolUse', { toolName: 'Read', toolUseId: 'toolu_3', payload: { tool_input: { file_path: DOC } } }));
		const kept = t.shown();
		// ID の無い hook は、同じペインの同じパスの終わりで消す
		t.hooks.fire(edit('pane-1', 'PreToolUse', undefined));
		t.hooks.fire(edit('pane-2', 'PostToolUse', undefined));
		const keptByOtherPane = t.shown();
		t.hooks.fire(edit('pane-1', 'PostToolUse', undefined));
		assert.deepStrictEqual({ kept, keptByOtherPane, after: t.shown() }, { kept: 'edit', keptByOtherPane: 'edit', after: undefined });
	});

	test('a Write replaces the Edit mark of the same document, and Codex and unverified hooks are ignored', () => {
		const t = setup();
		t.hooks.fire(hook('pane-1', 'PreToolUse', { agentKind: 'codex', transcriptPath: '/home/u/.codex/sessions/rollout-1.jsonl', toolName: 'Edit', toolUseId: 'c1', payload: { tool_input: { file_path: DOC, old_string: 'x' } } }));
		t.hooks.fire({ ...edit('pane-1', 'PreToolUse', 'toolu_1'), ownerUnverified: true });
		const ignored = t.shown();
		t.hooks.fire(edit('pane-1', 'PreToolUse', 'toolu_1'));
		t.hooks.fire(hook('pane-1', 'PreToolUse', { toolName: 'Write', toolUseId: 'toolu_2', payload: { tool_input: { file_path: DOC, content: '# x' } } }));
		const replaced = t.shown();
		// 前の Edit の終わりは、入れ替わった Write の印を消さない
		t.hooks.fire(edit('pane-1', 'PostToolUse', 'toolu_1'));
		assert.deepStrictEqual({ ignored, replaced, afterOldEnd: t.shown(), changes: t.changes }, {
			ignored: undefined,
			replaced: 'write',
			afterOldEnd: 'write',
			changes: [`${DOC}:edit`, `${DOC}:write`],
		});
	});

	test('the channel checks the document it is asked about', async () => {
		const t = setup();
		const channel = new ParadisDocEditingChannel(t.tracker);
		t.hooks.fire(edit('pane-1', 'PreToolUse', 'toolu_1'));
		const mark = await channel.call<{ tool: string } | undefined>(undefined, 'get', ['', DOC]);
		await assert.rejects(channel.call(undefined, 'get', ['', '/repo/src/a.ts']));
		await assert.rejects(channel.call(undefined, 'remove', ['', DOC]));
		assert.deepStrictEqual(mark?.tool, 'edit');
	});
});
