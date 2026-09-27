/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	PARADIS_AGENT_IDE_ACTIONS_DISABLED_MESSAGE,
	PARADIS_AGENT_IDE_ACTION_TOOLS,
	PARADIS_AGENT_IDE_MAX_WAIT_SECONDS,
	PARADIS_AGENT_IDE_TOOLS,
	ParadisAgentStopWatcher,
	paradisAgentIdeActionScope,
	paradisAgentIdeActionsAllowed,
	paradisAgentIdeKeySequence,
	paradisAgentIdeMessagePrefix,
	paradisAgentIdeSanitizeInput,
	paradisAgentIdeStatusLabel,
	paradisAgentIdeTailLines,
	paradisAgentIdeUntrustedTitle,
	paradisParseAgentIdeCall,
} from '../../common/paradisAgentIde.js';
import { PARADIS_AGENT_IDE_SKILL_CONTENT, paradisAgentIdeGuide } from '../../common/paradisAgentIdeGuide.js';

suite('paradisAgentIde (common)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('settings fall back to the safe side', () => {
		assert.deepStrictEqual(
			[paradisAgentIdeActionsAllowed(true), paradisAgentIdeActionsAllowed('true'), paradisAgentIdeActionsAllowed(undefined), paradisAgentIdeActionScope('window'), paradisAgentIdeActionScope('everything'), paradisAgentIdeActionScope(undefined)],
			[true, false, false, 'window', 'space', 'space'],
		);
	});

	test('action tools are annotated as destructive and the others as read-only', () => {
		const annotations = PARADIS_AGENT_IDE_TOOLS.map(tool => ({ name: tool.name, readOnly: (tool.annotations as { readOnlyHint: boolean }).readOnlyHint, destructive: (tool.annotations as { destructiveHint: boolean }).destructiveHint }));
		assert.deepStrictEqual({
			count: annotations.length,
			actionsDestructive: annotations.filter(tool => PARADIS_AGENT_IDE_ACTION_TOOLS.has(tool.name)).every(tool => tool.destructive && !tool.readOnly),
			othersReadOnly: annotations.filter(tool => !PARADIS_AGENT_IDE_ACTION_TOOLS.has(tool.name)).every(tool => tool.readOnly && !tool.destructive),
		}, { count: 12, actionsDestructive: true, othersReadOnly: true });
	});

	test('send_terminal_input requires an explicit press_enter', () => {
		assert.deepStrictEqual([
			paradisParseAgentIdeCall('send_terminal_input', { terminal: 't_1', text: 'hi' }),
			paradisParseAgentIdeCall('send_terminal_input', { terminal: 't_1', text: 'hi', press_enter: 'yes' }),
			paradisParseAgentIdeCall('send_terminal_input', { terminal: 't_1', text: 'hi', press_enter: true }),
		].map(result => result.kind === 'error' ? 'error' : result), [
			'error',
			'error',
			{ kind: 'input', terminal: 't_1', text: 'hi', pressEnter: true },
		]);
	});

	test('control characters are removed from sent text but newlines stay', () => {
		assert.deepStrictEqual(
			paradisAgentIdeSanitizeInput('a\x1b[201~b\r\nc\td\x07\u009b'),
			'a[201~b\nc    d',
		);
	});

	test('wait arguments are validated and clamped', () => {
		assert.deepStrictEqual([
			paradisParseAgentIdeCall('wait_for_terminal', { terminal: 't_1', until: 'agent_stopped', timeout_seconds: 9999 }),
			paradisParseAgentIdeCall('wait_for_terminal', { terminal: 't_1', until: 'agent_stopped' }),
			paradisParseAgentIdeCall('wait_for_terminal', { terminal: 't_1', until: 'text' }).kind,
			paradisParseAgentIdeCall('wait_for_terminal', { terminal: 't_1', until: 'done' }).kind,
		], [
			{ kind: 'wait', terminal: 't_1', until: 'agent_stopped', timeoutSeconds: PARADIS_AGENT_IDE_MAX_WAIT_SECONDS },
			{ kind: 'wait', terminal: 't_1', until: 'agent_stopped', timeoutSeconds: 50 },
			'error',
			'error',
		]);
	});

	test('reading defaults to the visible screen; create_space does not run setup unless asked; no permission ids', () => {
		const launch = paradisParseAgentIdeCall('launch_agent', { agent: 'claude', permission: 'skipAll' });
		assert.deepStrictEqual([
			paradisParseAgentIdeCall('list_terminals', {}),
			paradisParseAgentIdeCall('read_terminal', { terminal: 't_1' }),
			paradisParseAgentIdeCall('read_terminal', { terminal: 't_1', scrollback_lines: 9999 }),
			paradisParseAgentIdeCall('create_space', { prompt: 'x' }),
			launch.kind === 'window' && Object.keys(launch.request).some(key => key.startsWith('permission')),
		], [
			{ kind: 'window', action: false, request: { op: 'listTerminals' } },
			{ kind: 'window', action: false, request: { op: 'readTerminal', terminal: 't_1', scrollbackLines: 0 } },
			{ kind: 'window', action: false, request: { op: 'readTerminal', terminal: 't_1', scrollbackLines: 500 } },
			{ kind: 'window', action: true, request: { op: 'createSpace', prompt: 'x', runSetup: false } },
			false,
		]);
	});

	test('stop watcher: waits for the start, then for the end, and never calls silence "stopped"', () => {
		const watcher = new ParadisAgentStopWatcher(1000);
		const idleWatcher = new ParadisAgentStopWatcher(1000);
		const launchedWatcher = new ParadisAgentStopWatcher(1000, 90_000);
		assert.deepStrictEqual({
			busy: [watcher.observe('finished', 500, 1500), watcher.observe('working', 1600, 2000), watcher.observe('finished', 2500, 2600)],
			idle: [idleWatcher.observe('idle', undefined, 3000), idleWatcher.observe('idle', undefined, 6000)],
			launched: launchedWatcher.observe('idle', undefined, 30_000),
			needsHuman: new ParadisAgentStopWatcher(1000).observe('asking_question', 500, 1000),
		}, { busy: ['waiting', 'waiting', 'stopped'], idle: ['waiting', 'no_agent_status'], launched: 'waiting', needsHuman: 'needs_input' });
	});

	test('status labels, key sequences, tail lines, titles and the agent marker', () => {
		assert.deepStrictEqual({
			labels: [paradisAgentIdeStatusLabel('working'), paradisAgentIdeStatusLabel('permission'), paradisAgentIdeStatusLabel('question'), paradisAgentIdeStatusLabel('review'), paradisAgentIdeStatusLabel(undefined)],
			keys: [paradisAgentIdeKeySequence('up', false), paradisAgentIdeKeySequence('up', true), paradisAgentIdeKeySequence('ctrl_c', false)],
			tail: paradisAgentIdeTailLines(['a', 'b  ', 'c', '', '  '], 2),
			title: paradisAgentIdeUntrustedTitle(`x\x1b]0;evil\x07${'y'.repeat(100)}`).length,
			marker: paradisAgentIdeMessagePrefix('t_abc').includes('not typed by the user'),
		}, {
			labels: ['working', 'waiting_for_permission', 'asking_question', 'finished', 'idle'],
			keys: ['\x1b[A', '\x1bOA', '\x03'],
			tail: 'b\nc',
			title: 83,
			marker: true,
		});
	});

	test('guide and messages point at the real settings, and the skill points at the guide tool', () => {
		const guide = paradisAgentIdeGuide({ actionsEnabled: false, actionScope: 'space', readOtherSpaces: false, shellCommands: false });
		assert.deepStrictEqual({
			off: guide.includes('Actions are OFF') && guide.includes('paradis.agentIde.allowActions'),
			on: paradisAgentIdeGuide({ actionsEnabled: true, actionScope: 'window', readOtherSpaces: true, shellCommands: false }).includes('every terminal in this window'),
			message: PARADIS_AGENT_IDE_ACTIONS_DISABLED_MESSAGE.includes('paradis.agentIde.allowActions'),
			skill: PARADIS_AGENT_IDE_SKILL_CONTENT.startsWith('---\nname: para-code\n') && PARADIS_AGENT_IDE_SKILL_CONTENT.includes('read_para_code_guide'),
		}, { off: true, on: true, message: true, skill: true });
	});
});
