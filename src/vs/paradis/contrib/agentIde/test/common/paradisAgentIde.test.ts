/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	PARADIS_AGENT_IDE_ACTION_TOOLS,
	PARADIS_AGENT_IDE_MAX_WAIT_SECONDS,
	PARADIS_AGENT_IDE_TOOLS,
	ParadisAgentStopWatcher,
	paradisAgentIdeActionScope,
	paradisAgentIdeActionsAllowed,
	paradisAgentIdeKeySequence,
	paradisAgentIdeSanitizeInput,
	paradisAgentIdeStatusLabel,
	paradisAgentIdeTailLines,
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

	test('every action tool is listed and the list stays small', () => {
		const names = PARADIS_AGENT_IDE_TOOLS.map(tool => tool.name);
		assert.deepStrictEqual({ count: names.length, actionsListed: [...PARADIS_AGENT_IDE_ACTION_TOOLS].every(name => names.includes(name)) }, { count: 12, actionsListed: true });
	});

	test('send_terminal_input requires an explicit press_enter', () => {
		assert.deepStrictEqual([
			paradisParseAgentIdeCall('send_terminal_input', { terminal: 't_1', text: 'hi' }),
			paradisParseAgentIdeCall('send_terminal_input', { terminal: 't_1', text: 'hi', press_enter: 'yes' }),
			paradisParseAgentIdeCall('send_terminal_input', { terminal: 't_1', text: 'hi', press_enter: true }),
		].map(result => result.kind === 'error' ? 'error' : result), [
			'error',
			'error',
			{ kind: 'window', action: true, request: { op: 'sendInput', terminal: 't_1', text: 'hi', pressEnter: true } },
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
			paradisParseAgentIdeCall('wait_for_terminal', { terminal: 't_1', until: 'text' }).kind,
			paradisParseAgentIdeCall('wait_for_terminal', { terminal: 't_1', until: 'done' }).kind,
		], [
			{ kind: 'wait', terminal: 't_1', until: 'agent_stopped', timeoutSeconds: PARADIS_AGENT_IDE_MAX_WAIT_SECONDS },
			'error',
			'error',
		]);
	});

	test('read-only tools are not actions, and permission ids are never accepted', () => {
		const launch = paradisParseAgentIdeCall('launch_agent', { agent: 'claude', permission: 'skipAll' });
		assert.deepStrictEqual([
			paradisParseAgentIdeCall('list_terminals', {}),
			paradisParseAgentIdeCall('read_terminal', { terminal: 't_1', lines: 0 }),
			launch.kind,
		], [
			{ kind: 'window', action: false, request: { op: 'listTerminals' } },
			{ kind: 'window', action: false, request: { op: 'readTerminal', terminal: 't_1', lines: 1 } },
			'window',
		]);
		assert.ok(launch.kind === 'window' && !Object.keys(launch.request).some(key => key.startsWith('permission')));
	});

	test('stop watcher: waits for the start, then for the end', () => {
		const watcher = new ParadisAgentStopWatcher(1000);
		const idleWatcher = new ParadisAgentStopWatcher(1000);
		assert.deepStrictEqual({
			busy: [watcher.observe('finished', 500, 1500), watcher.observe('working', 1600, 2000), watcher.observe('finished', 2500, 2600)],
			idle: [idleWatcher.observe('idle', undefined, 3000), idleWatcher.observe('idle', undefined, 6000)],
			needsHuman: new ParadisAgentStopWatcher(1000).observe('asking_question', 500, 1000),
		}, { busy: [false, false, true], idle: [false, true], needsHuman: true });
	});

	test('status labels, key sequences and tail lines', () => {
		assert.deepStrictEqual({
			labels: [paradisAgentIdeStatusLabel('working'), paradisAgentIdeStatusLabel('permission'), paradisAgentIdeStatusLabel('question'), paradisAgentIdeStatusLabel('review'), paradisAgentIdeStatusLabel(undefined)],
			keys: [paradisAgentIdeKeySequence('up', false), paradisAgentIdeKeySequence('up', true), paradisAgentIdeKeySequence('ctrl_c', false)],
			tail: paradisAgentIdeTailLines(['a', 'b  ', 'c', '', '  '], 2),
		}, {
			labels: ['working', 'waiting_for_permission', 'asking_question', 'finished', 'idle'],
			keys: ['\x1b[A', '\x1bOA', '\x03'],
			tail: 'b\nc',
		});
	});

	test('guide reflects whether actions are enabled, and the skill points at the guide tool', () => {
		assert.deepStrictEqual({
			off: paradisAgentIdeGuide({ actionsEnabled: false, actionScope: 'space' }).includes('Actions are OFF'),
			on: paradisAgentIdeGuide({ actionsEnabled: true, actionScope: 'window' }).includes('every terminal in this window'),
			skill: PARADIS_AGENT_IDE_SKILL_CONTENT.startsWith('---\nname: para-code\n') && PARADIS_AGENT_IDE_SKILL_CONTENT.includes('read_para_code_guide'),
		}, { off: true, on: true, skill: true });
	});
});
