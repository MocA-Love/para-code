/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisAgentTeamTracker, paradisParseTeamConfig, paradisTeamMemberRead, paradisTeamsForStoppedPane } from '../../common/paradisAgentTeams.js';
import { IParseSignals, newParseSignals, parseClaudeLine } from '../../common/paradisAgentTranscriptParser.js';

const T0 = Date.parse('2026-10-07T10:45:00.000Z');

function iso(offsetMs: number): string {
	return new Date(T0 + offsetMs).toISOString();
}

/** 2.1.292 の実測（2 人の in-process のチーム）と同じ形のリーダーの記録。本文は作りもの。 */
function leaderLines(): Record<string, unknown>[] {
	const spawn = (toolUseId: string, name: string, agentId: string, color: string, agentType: string, offsetMs: number) => ({
		type: 'user', timestamp: iso(offsetMs),
		toolUseResult: {
			status: 'teammate_spawned', prompt: '…', agentId, resolvedModel: 'claude-opus-5-5', teammate_id: `${name}@session-29ad7e4e`, agent_id: agentId, agent_type: agentType,
			model: 'opus', name, color, tmux_session_name: 'in-process', tmux_window_name: 'in-process', tmux_pane_id: 'in-process', team_name: 'session-29ad7e4e', is_splitpane: false, plan_mode_required: false,
		},
		message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'Spawned successfully.' }] },
	});
	return [
		{
			type: 'assistant', timestamp: iso(0), message: {
				content: [
					{ type: 'tool_use', id: 'toolu_team1', name: 'Agent', input: { description: '見出しを数える', name: 'heading-counter', subagent_type: 'Explore', prompt: 'README の見出しを数えて報告して' } },
					{ type: 'tool_use', id: 'toolu_team2', name: 'Agent', input: { description: '1 行足す計画', name: 'readme-planner', subagent_type: 'Plan', prompt: 'README に 1 行足す計画を立てて' } },
				],
			},
		},
		spawn('toolu_team1', 'heading-counter', 'aheading-counter-1eb21a843ca95912', 'blue', 'Explore', 1_000),
		spawn('toolu_team2', 'readme-planner', 'areadme-planner-25560eb36d9ffe23', 'green', 'Plan', 1_100),
		{
			type: 'user', timestamp: iso(28_000),
			message: { content: 'Another Claude session sent a message:\n<teammate-message teammate_id="heading-counter" color="blue" summary="見出し数の報告">見出しは 12 個です。</teammate-message>\n\nThis came from another Claude session.' },
		},
		{
			type: 'user', timestamp: iso(35_000),
			message: { content: 'Another Claude session sent a message:\n<teammate-message teammate_id="readme-planner" color="green" summary="計画の報告">末尾に 1 行足します。</teammate-message>\n<teammate-message teammate_id="heading-counter" color="blue">{"type":"idle_notification","from":"heading-counter","timestamp":"x","idleReason":"available","result":"done"}</teammate-message>\n<teammate-message teammate_id="readme-planner" color="green">{"type":"idle_notification","from":"readme-planner","timestamp":"x","idleReason":"available","result":"done"}</teammate-message>\n\nThis came from another Claude session.' },
		},
	];
}

function parse(lines: readonly Record<string, unknown>[]): IParseSignals {
	const signals = newParseSignals();
	for (const line of lines) {
		parseClaudeLine(line, signals);
	}
	return signals;
}

suite('paradisAgentTeams', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('リーダーの記録からメンバー・状態・やりとりを組み立てる（受けた報告は 1 行に複数あっても全部）', () => {
		const tracker = new ParadisAgentTeamTracker();
		assert.strictEqual(tracker.apply(parse(leaderLines()).teamSignals), true);
		const [team] = tracker.snapshot();
		assert.deepStrictEqual({
			name: team.name, leadName: team.leadName, toolUseIds: team.toolUseIds,
			members: team.members.map(member => [member.name, member.agentId, member.color, member.model, member.agentType, member.backend, member.state, member.description]),
			messages: team.messages.map(message => [message.from, message.to, message.kind, message.summary, message.text]),
		}, {
			name: 'session-29ad7e4e', leadName: 'team-lead', toolUseIds: ['toolu_team1', 'toolu_team2'],
			members: [
				['heading-counter', 'aheading-counter-1eb21a843ca95912', 'blue', 'claude-opus-5-5', 'Explore', 'in-process', 'idle', '見出しを数える'],
				['readme-planner', 'areadme-planner-25560eb36d9ffe23', 'green', 'claude-opus-5-5', 'Plan', 'in-process', 'idle', '1 行足す計画'],
			],
			messages: [
				['team-lead', 'heading-counter', 'instruction', '見出しを数える', 'README の見出しを数えて報告して'],
				['team-lead', 'readme-planner', 'instruction', '1 行足す計画', 'README に 1 行足す計画を立てて'],
				['heading-counter', 'team-lead', 'message', '見出し数の報告', '見出しは 12 個です。'],
				['readme-planner', 'team-lead', 'message', '計画の報告', '末尾に 1 行足します。'],
			],
		});
		// 読み直しで同じ記録をもう一度読んでも増えない
		assert.strictEqual(tracker.apply(parse(leaderLines()).teamSignals), false);
	});

	test('メンバーの記録の SendMessage は受けた側の報告と二重に数えず、メンバー同士のやりとりを足す。許可待ち・作業中・推定の停止', () => {
		const tracker = new ParadisAgentTeamTracker();
		tracker.apply(parse(leaderLines()).teamSignals);
		const read = paradisTeamMemberRead([
			{ type: 'user', timestamp: iso(2_000), message: { content: '<teammate-message teammate_id="team-lead">…</teammate-message>' } },
			{ type: 'assistant', timestamp: iso(27_700), message: { content: [{ type: 'tool_use', id: 't1', name: 'SendMessage', input: { to: 'team-lead', summary: '見出し数の報告', message: '見出しは 12 個です。', type: 'message' } }] } },
			{ type: 'assistant', timestamp: iso(40_000), message: { content: [{ type: 'tool_use', id: 't2', name: 'SendMessage', input: { to: 'readme-planner', summary: '見出しの一覧', message: '一覧はこれです' } }] } },
			{ type: 'assistant', timestamp: iso(41_000), message: { content: [{ type: 'tool_use', id: 't3', name: 'Read', input: { file_path: '/repo/docs/README.md' } }] } },
		]);
		assert.strictEqual(tracker.applyMember('aheading-counter-1eb21a843ca95912', read), true);
		const approvals = new Map([['areadme-planner-25560eb36d9ffe23', { id: 'approval-1', tool: 'Bash' }]]);
		const [team] = tracker.snapshot(approvals);
		const [stopped] = paradisTeamsForStoppedPane([team]);
		assert.deepStrictEqual({
			members: team.members.map(member => [member.name, member.state, member.activity, member.approvalId, member.approvalTool]),
			messages: team.messages.map(message => `${message.from}>${message.to}:${message.text}`),
			stopped: stopped.members.map(member => [member.state, member.estimated, member.approvalId]),
		}, {
			members: [
				['heading-counter', 'running', 'Read README.md', undefined, undefined],
				['readme-planner', 'waiting', undefined, 'approval-1', 'Bash'],
			],
			messages: [
				'team-lead>heading-counter:README の見出しを数えて報告して',
				'team-lead>readme-planner:README に 1 行足す計画を立てて',
				'heading-counter>team-lead:見出しは 12 個です。',
				'readme-planner>team-lead:末尾に 1 行足します。',
				'heading-counter>readme-planner:一覧はこれです',
			],
			stopped: [['stopped', true, undefined], ['stopped', true, undefined]],
		});
	});

	test('計画の依頼と答え、終了の応答、hook の印、config の別ペインのメンバー', () => {
		const tracker = new ParadisAgentTeamTracker();
		tracker.apply(parse(leaderLines()).teamSignals);
		tracker.apply(parse([
			{ type: 'user', timestamp: iso(50_000), message: { content: 'Another Claude session sent a message:\n<teammate-message teammate_id="readme-planner" color="green">{"type":"plan_approval_request","from":"readme-planner","planFilePath":"/x/plan.md","planContent":"1. 読む\\n2. 足す","requestId":"r1"}</teammate-message>' } },
		]).teamSignals);
		const planned = tracker.snapshot()[0];
		tracker.apply(parse([
			{ type: 'assistant', timestamp: iso(51_000), message: { content: [{ type: 'tool_use', id: 'toolu_s1', name: 'SendMessage', input: { to: 'readme-planner', message: { type: 'plan_approval_response', request_id: 'r1', approve: true } } }] } },
			{ type: 'user', timestamp: iso(60_000), message: { content: 'Another Claude session sent a message:\n<teammate-message teammate_id="heading-counter" color="blue">{"type":"shutdown_response","approve":true}</teammate-message>' } },
		]).teamSignals);
		tracker.noteHook('active', { agentId: 'areadme-planner-25560eb36d9ffe23' }, T0 + 70_000, 'Edit README.md');
		tracker.applyConfig('session-29ad7e4e', paradisParseTeamConfig({
			name: 'session-29ad7e4e', leadAgentId: 'team-lead@session-29ad7e4e', members: [
				{ agentId: 'team-lead@session-29ad7e4e', name: 'team-lead', agentType: 'team-lead', backendType: 'in-process' },
				{ agentId: 'tester@session-29ad7e4e', name: 'tester', agentType: 'general-purpose', model: 'sonnet', color: 'yellow', backendType: 'tmux', joinedAt: T0 + 80_000 },
			],
		})!);
		const team = tracker.snapshot()[0];
		assert.deepStrictEqual({
			planned: planned.members.map(member => member.state),
			plans: team.plans,
			members: team.members.map(member => [member.name, member.state, member.backend, member.activity ?? null]),
		}, {
			planned: ['idle', 'plan'],
			plans: [{ from: 'readme-planner', text: '1. 読む\n2. 足す', at: T0 + 50_000, approved: true }],
			members: [
				['heading-counter', 'completed', 'in-process', null],
				['readme-planner', 'running', 'in-process', 'Edit README.md'],
				['tester', 'running', 'tmux', null],
			],
		});
	});

	test('起動を見ていない config は読まず、SendMessage でのバックグラウンドの子の再開はやりとりに数えない', () => {
		const tracker = new ParadisAgentTeamTracker();
		assert.strictEqual(tracker.applyConfig('session-old', { members: [{ name: 'x', backend: 'in-process' }] }), false);
		tracker.apply(parse(leaderLines()).teamSignals);
		assert.strictEqual(tracker.apply(parse([
			{ type: 'assistant', timestamp: iso(90_000), message: { content: [{ type: 'tool_use', id: 'toolu_r1', name: 'SendMessage', input: { to: 'a1b2c3d4e5', message: '続けて' } }] } },
		]).teamSignals), false);
		assert.strictEqual(tracker.snapshot().length, 1);
	});
});
