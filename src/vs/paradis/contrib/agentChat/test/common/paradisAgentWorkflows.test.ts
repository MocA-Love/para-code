/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_WORKFLOW_LIMITS, ParadisAgentWorkflowTracker, paradisParseWorkflowJournalLine, paradisParseWorkflowResultFile, paradisParseWorkflowScriptMeta, paradisWorkflowsForStoppedPane } from '../../common/paradisAgentWorkflows.js';
import { IParseSignals, newParseSignals, parseClaudeLine, rec } from '../../common/paradisAgentTranscriptParser.js';

const T0 = Date.parse('2026-10-06T08:00:00.000Z');

function iso(offsetMs: number): string {
	return new Date(T0 + offsetMs).toISOString();
}

const SCRIPT = [
	'export const meta = {',
	'  name: \'security-audit\',',
	'  description: \'Audit from 2 angles\',',
	'  phases: [{ title: \'Find\', detail: \'look in parallel\' }, { title: \'Verify\' }],',
	'}',
	'phase(\'Find\')',
	'const a = await agent(`x ${1}`, { label: \'find:authz\' })',
].join('\n');

function workflowUse(toolUseId: string, input: Record<string, unknown>, offsetMs = 0): string {
	return JSON.stringify({ type: 'assistant', timestamp: iso(offsetMs), message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Workflow', input }] } });
}

function launched(toolUseId: string, taskId: string, runId: string, offsetMs = 100): string {
	return JSON.stringify({
		type: 'user', timestamp: iso(offsetMs),
		toolUseResult: { status: 'async_launched', taskId, taskType: 'local_workflow', workflowName: 'security-audit', runId, summary: 'Audit from 2 angles' },
		message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: `Workflow launched in background. Task ID: ${taskId}` }] },
	});
}

function notification(taskId: string, status: string, offsetMs: number): string {
	return JSON.stringify({ type: 'user', timestamp: iso(offsetMs), message: { role: 'user', content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>${status}</status>\n<summary>Dynamic workflow "x" ${status}</summary>\n</task-notification>` } });
}

function parse(lines: readonly string[]): IParseSignals {
	const signals = newParseSignals();
	for (const line of lines) {
		parseClaudeLine(rec(JSON.parse(line))!, signals);
	}
	return signals;
}

suite('paradisAgentWorkflows', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the name, description and phases from the meta literal of a script', () => {
		assert.deepStrictEqual({
			meta: paradisParseWorkflowScriptMeta(SCRIPT),
			nested: paradisParseWorkflowScriptMeta('export const meta = { name: "n", description: \'it\\\'s ok\', whenToUse: \'{ not: [a] }\', phases: [{ title: \'A\', model: \'x\' }, { title: `B` }] }'),
			noMeta: paradisParseWorkflowScriptMeta('const a = await agent("x")'),
			broken: paradisParseWorkflowScriptMeta('export const meta = { name: \'x\''),
		}, {
			meta: { name: 'security-audit', description: 'Audit from 2 angles', phases: [{ title: 'Find', detail: 'look in parallel' }, { title: 'Verify' }] },
			nested: { name: 'n', description: 'it\'s ok', phases: [{ title: 'A' }, { title: 'B' }] },
			noMeta: undefined,
			broken: undefined,
		});
	});

	test('reads journal lines of every version, and result lines only from their head', () => {
		const hugeResult = `{"type":"result","key":"v2:${'a'.repeat(64)}","agentId":"a1b2","result":"${'x'.repeat(200_000)}`;
		assert.deepStrictEqual([
			paradisParseWorkflowJournalLine('{"type":"launched"}'),
			paradisParseWorkflowJournalLine('{"type":"started","key":"v2:00","agentId":"a1b2"}'),
			paradisParseWorkflowJournalLine('{"type":"started","key":"v2:00","agentId":"a1b2","label":"find:authz","phase":"Find"}'),
			paradisParseWorkflowJournalLine(hugeResult),
			paradisParseWorkflowJournalLine('{"type":"failed","key":"v2:00","agentId":"a1b2"}'),
			paradisParseWorkflowJournalLine('{"type":"started","key":"v2:00","agentId":"../x"}'),
			paradisParseWorkflowJournalLine('{"type":"start'),
		], [
			undefined,
			{ type: 'started', agentId: 'a1b2' },
			{ type: 'started', agentId: 'a1b2', label: 'find:authz', phase: 'Find' },
			{ type: 'result', agentId: 'a1b2' },
			{ type: 'failed', agentId: 'a1b2' },
			undefined,
			undefined,
		]);
	});

	test('follows a run from the launch, through the journal and the children, to the end notice', () => {
		const tracker = new ParadisAgentWorkflowTracker();
		const launch = parse([workflowUse('toolu_wf1', { script: SCRIPT }), launched('toolu_wf1', 'wtask1', 'wf_run-1')]);
		const changedOnLaunch = tracker.apply(launch.workflowSignals, launch.shellSignals);
		tracker.applyChildren('wf_run-1', [{ agentId: 'achild1', label: 'find:authz', phase: 'Find', startedAt: T0 + 200 }, { agentId: 'achild2', startedAt: T0 + 300 }]);
		tracker.applyJournal('wf_run-1', [
			{ type: 'started', agentId: 'achild1' },
			{ type: 'started', agentId: 'achild2', label: 'verify:authz', phase: 'Verify' },
			{ type: 'result', agentId: 'achild1' },
			{ type: 'started', agentId: 'achild3', label: 'extra', phase: 'Report' },
			{ type: 'failed', agentId: 'achild3' },
		]);
		const running = tracker.snapshot();
		const end = parse([notification('wtask1', 'completed', 60_000)]);
		const changedOnEnd = tracker.apply(end.workflowSignals, end.shellSignals);
		assert.deepStrictEqual({ changedOnLaunch, running, changedOnEnd, ended: tracker.snapshot()[0], refresh: tracker.runsToRefresh() }, {
			changedOnLaunch: true,
			running: [{
				runId: 'wf_run-1', taskId: 'wtask1', toolUseId: 'toolu_wf1', name: 'security-audit', summary: 'Audit from 2 angles', status: 'running', startedAt: T0 + 100,
				phases: [{ title: 'Find', detail: 'look in parallel' }, { title: 'Verify' }, { title: 'Report' }],
				agents: [
					{ id: 'achild1', label: 'find:authz', phase: 0, state: 'done', startedAt: T0 + 200 },
					{ id: 'achild2', label: 'verify:authz', phase: 1, state: 'running', startedAt: T0 + 300 },
					{ id: 'achild3', label: 'extra', phase: 2, state: 'failed' },
				],
				agentCount: 3, counts: { running: 1, done: 1, failed: 1, stopped: 0 },
			}],
			changedOnEnd: true,
			ended: {
				runId: 'wf_run-1', taskId: 'wtask1', toolUseId: 'toolu_wf1', name: 'security-audit', summary: 'Audit from 2 angles', status: 'completed', startedAt: T0 + 100, endedAt: T0 + 60_000,
				phases: [{ title: 'Find', detail: 'look in parallel' }, { title: 'Verify' }, { title: 'Report' }],
				agents: [
					{ id: 'achild1', label: 'find:authz', phase: 0, state: 'done', startedAt: T0 + 200 },
					{ id: 'achild2', label: 'verify:authz', phase: 1, state: 'stopped', startedAt: T0 + 300 },
					{ id: 'achild3', label: 'extra', phase: 2, state: 'failed' },
				],
				agentCount: 3, counts: { running: 0, done: 1, failed: 1, stopped: 1 },
			},
			// 終わっても `<runId>.json` を当てるまでは読み直す
			refresh: [{ runId: 'wf_run-1', running: false, launchedAt: T0 + 100 }],
		});
	});

	test('the result file fills tokens and per-child numbers; a resume of the same run ignores the previous result', () => {
		const tracker = new ParadisAgentWorkflowTracker();
		const launch = parse([workflowUse('toolu_wf1', { script: SCRIPT }), launched('toolu_wf1', 'wtask1', 'wf_run-1')]);
		tracker.apply(launch.workflowSignals);
		const result = paradisParseWorkflowResultFile({
			runId: 'wf_run-1', taskId: 'wtask1', script: SCRIPT, result: { big: 'x' }, logs: ['a'], status: 'completed', workflowName: 'security-audit',
			startTime: T0 + 100, durationMs: 50_000, timestamp: iso(50_100), agentCount: 2, totalTokens: 38_452, totalToolCalls: 2,
			phases: [{ title: 'Find', detail: 'look in parallel' }, { title: 'Verify' }],
			workflowProgress: [
				{ type: 'workflow_phase', index: 1, title: 'Find' },
				{ type: 'workflow_phase', index: 2, title: 'Verify' },
				{ type: 'workflow_agent', index: 1, label: 'find:authz', phaseIndex: 1, phaseTitle: 'Find', agentId: 'achild1', state: 'done', startedAt: T0 + 200, tokens: 20_434, toolCalls: 2, durationMs: 15_441, lastToolName: 'Bash', promptPreview: 'secret prompt' },
				{ type: 'workflow_agent', index: 2, label: 'verify:authz', phaseIndex: 2, phaseTitle: 'Verify', agentId: 'achild2', state: 'error', startedAt: T0 + 300, tokens: 18_018, toolCalls: 0, durationMs: 2_072 },
			],
		})!;
		const applied = tracker.applyResult('wf_run-1', result, T0 + 50_100);
		const completed = tracker.snapshot()[0];
		// resume: 同じ runId・新しいタスク ID。前の結果のファイル（前の起動より前に書かれた）は当てない
		const resume = parse([workflowUse('toolu_wf2', { scriptPath: '/x/security-audit-wf_run-1.js', resumeFromRunId: 'wf_run-1' }, 70_000), launched('toolu_wf2', 'wtask2', 'wf_run-1', 70_100)]);
		tracker.apply(resume.workflowSignals);
		const staleApplied = tracker.applyResult('wf_run-1', result, T0 + 50_100);
		assert.deepStrictEqual({ applied, completed, staleApplied, resumed: tracker.snapshot() }, {
			applied: true,
			completed: {
				runId: 'wf_run-1', taskId: 'wtask1', toolUseId: 'toolu_wf1', name: 'security-audit', summary: 'Audit from 2 angles', status: 'completed', startedAt: T0 + 100, endedAt: T0 + 50_100, durationMs: 50_000,
				phases: [{ title: 'Find', detail: 'look in parallel' }, { title: 'Verify' }],
				agents: [
					{ id: 'achild1', label: 'find:authz', phase: 0, state: 'done', startedAt: T0 + 200, durationMs: 15_441, tokens: 20_434, toolCalls: 2, lastTool: 'Bash' },
					{ id: 'achild2', label: 'verify:authz', phase: 1, state: 'failed', startedAt: T0 + 300, durationMs: 2_072, tokens: 18_018, toolCalls: 0 },
				],
				agentCount: 2, counts: { running: 0, done: 1, failed: 1, stopped: 0 }, totalTokens: 38_452, totalToolCalls: 2,
			},
			staleApplied: false,
			resumed: [{
				runId: 'wf_run-1', taskId: 'wtask2', toolUseId: 'toolu_wf2', name: 'security-audit', summary: 'Audit from 2 angles', status: 'running', startedAt: T0 + 70_100,
				phases: [{ title: 'Find', detail: 'look in parallel' }, { title: 'Verify' }],
				agents: [
					{ id: 'achild1', label: 'find:authz', phase: 0, state: 'done', startedAt: T0 + 200, durationMs: 15_441, tokens: 20_434, toolCalls: 2, lastTool: 'Bash' },
					{ id: 'achild2', label: 'verify:authz', phase: 1, state: 'failed', startedAt: T0 + 300, durationMs: 2_072, tokens: 18_018, toolCalls: 0 },
				],
				agentCount: 2, counts: { running: 0, done: 1, failed: 1, stopped: 0 },
			}],
		});
	});

	test('the result after a resume drops children of the earlier launch that it does not list', () => {
		const tracker = new ParadisAgentWorkflowTracker();
		tracker.apply(parse([launched('toolu_wf1', 'wtask1', 'wf_r')]).workflowSignals);
		tracker.applyJournal('wf_r', [{ type: 'started', agentId: 'aold' }, { type: 'failed', agentId: 'aold' }]);
		tracker.apply(parse([launched('toolu_wf2', 'wtask2', 'wf_r', 10_000)]).workflowSignals);
		const revision = tracker.revision;
		tracker.applyResult('wf_r', paradisParseWorkflowResultFile({ status: 'completed', workflowProgress: [{ type: 'workflow_agent', agentId: 'anew', state: 'done' }] })!, T0 + 20_000);
		const [workflow] = tracker.snapshot();
		assert.deepStrictEqual({ agents: workflow.agents.map(agent => `${agent.id}:${agent.state}`), counts: workflow.counts, bumped: tracker.revision > revision }, {
			agents: ['anew:done'],
			counts: { running: 0, done: 1, failed: 0, stopped: 0 },
			bumped: true,
		});
	});

	test('sends at most the cap of children, keeping failed and running ones, and estimates a stopped pane', () => {
		const tracker = new ParadisAgentWorkflowTracker();
		const launch = parse([launched('toolu_wf1', 'wtask1', 'wf_many')]);
		tracker.apply(launch.workflowSignals);
		const total = PARADIS_WORKFLOW_LIMITS.agentsSent + 30;
		tracker.applyJournal('wf_many', Array.from({ length: total }, (_, index) => ({ type: 'started' as const, agentId: `a${index}` })));
		tracker.applyJournal('wf_many', Array.from({ length: total - 5 }, (_, index) => ({ type: index === 3 ? 'failed' as const : 'result' as const, agentId: `a${index}` })));
		const [workflow] = tracker.snapshot();
		const [stopped] = paradisWorkflowsForStoppedPane([workflow], T0 + 90_000);
		assert.deepStrictEqual({
			sent: workflow.agents.length,
			agentCount: workflow.agentCount,
			counts: workflow.counts,
			keptFailed: workflow.agents.some(agent => agent.id === 'a3'),
			keptRunning: workflow.agents.filter(agent => agent.state === 'running').length,
			stopped: { status: stopped.status, estimated: stopped.estimated, endedAt: stopped.endedAt, counts: stopped.counts, running: stopped.agents.filter(agent => agent.state === 'running').length },
		}, {
			sent: PARADIS_WORKFLOW_LIMITS.agentsSent,
			agentCount: total,
			counts: { running: 5, done: total - 6, failed: 1, stopped: 0 },
			keptFailed: true,
			keptRunning: 5,
			stopped: { status: 'stopped', estimated: true, endedAt: T0 + 90_000, counts: { running: 0, done: total - 6, failed: 1, stopped: 5 }, running: 0 },
		});
	});

	test('a killed run is stopped, and a SubagentStop counts a child that the journal never showed', () => {
		const tracker = new ParadisAgentWorkflowTracker();
		const launch = parse([launched('toolu_wf1', 'wtask1', 'wf_ssh')]);
		tracker.apply(launch.workflowSignals);
		const counted = tracker.noteChildStopped('wf_ssh', 'aremote1');
		const ended = parse([notification('wtask1', 'killed', 5_000)]);
		tracker.apply(ended.workflowSignals, ended.shellSignals);
		const [workflow] = tracker.snapshot();
		assert.deepStrictEqual({ counted, status: workflow.status, agents: workflow.agents, owner: tracker.runOfAgent('aremote1'), hasRunning: tracker.hasRunning() }, {
			counted: true,
			status: 'stopped',
			agents: [{ id: 'aremote1', state: 'done' }],
			owner: 'wf_ssh',
			hasRunning: false,
		});
	});
});
