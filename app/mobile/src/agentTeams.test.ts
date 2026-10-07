// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { localizeAgentTeams, parseAgentTeams, teamCardMembers, teamMemberLine, teamMessageHeadline, teamStateSummary, teamTone, teamWaitingMembers, type AgentTeamMember } from './agentTeams.js';

function member(name: string, state: AgentTeamMember['state'], extra: Partial<AgentTeamMember> = {}): AgentTeamMember {
	return { name, backend: 'in-process', state, startedAt: 100, updatedAt: 100, ...extra };
}

describe('エージェントチーム（agent.teams.v1）', () => {
	test('形の合わない要素を捨て、時刻を手元の時計へ直す', () => {
		const parsed = parseAgentTeams([
			{
				name: 'session-a', leadName: 'team-lead', toolUseIds: ['t1', 'bad id'], startedAt: 1000, updatedAt: 2000, messageCount: 9,
				members: [
					{ name: 'counter', agentId: 'acounter-1', color: 'blue', backend: 'in-process', state: 'waiting', approvalId: 'toolu_1', approvalTool: 'Bash', startedAt: 1000, updatedAt: 1500 },
					{ name: 'x', state: 'dancing', startedAt: 1, updatedAt: 1 },
					{ name: 'tester', backend: 'warp', state: 'idle', startedAt: 1100, updatedAt: 1100 },
				],
				messages: [{ id: 'm1', from: 'counter', to: 'team-lead', kind: 'message', summary: '報告', text: '本文', at: 1200 }, { id: 'm2', from: 'a', kind: 'message', text: 'x', at: 1 }],
				plans: [{ from: 'counter', text: '1. 読む', at: 1300, approved: false, feedback: 'もう少し' }],
			},
			{ name: 'broken' },
		]);
		expect(parsed).toEqual([{
			name: 'session-a', leadName: 'team-lead', toolUseIds: ['t1'], startedAt: 1000, updatedAt: 2000, messageCount: 9,
			members: [
				{ name: 'counter', agentId: 'acounter-1', color: 'blue', backend: 'in-process', state: 'waiting', approvalId: 'toolu_1', approvalTool: 'Bash', startedAt: 1000, updatedAt: 1500 },
				{ name: 'tester', backend: 'other', state: 'idle', startedAt: 1100, updatedAt: 1100 },
			],
			messages: [{ id: 'm1', from: 'counter', to: 'team-lead', kind: 'message', summary: '報告', text: '本文', at: 1200 }],
			plans: [{ from: 'counter', text: '1. 読む', at: 1300, approved: false, feedback: 'もう少し' }],
		}]);
		expect(parseAgentTeams({})).toBeUndefined();
		const localized = localizeAgentTeams(parsed!, 2000, 5000)[0]!;
		expect([localized.startedAt, localized.members[0]!.updatedAt, localized.messages[0]!.at, localized.plans![0]!.at]).toEqual([4000, 4500, 4200, 4300]);
	});

	test('カードは要対応と作業中を先に、7 人以上なら 5 人と「ほか N 人」。チームの状態と数え方', () => {
		const members = [
			member('a', 'completed'), member('b', 'idle'), member('c', 'running'), member('d', 'waiting', { approvalId: 'p1', approvalTool: 'Bash' }),
			member('e', 'idle'), member('f', 'idle'), member('g', 'plan'),
		];
		const card = teamCardMembers({ members });
		expect({
			shown: card.shown.map(item => item.name), hidden: card.hidden,
			six: teamCardMembers({ members: members.slice(0, 6) }).hidden,
			tone: [teamTone({ members }), teamTone({ members: [member('a', 'running')] }), teamTone({ members: [member('a', 'completed')] }), teamTone({ members: [member('a', 'stopped'), member('b', 'completed')] })],
			summary: teamStateSummary({ members }),
			waiting: teamWaitingMembers({ members }).map(item => item.name),
		}).toEqual({
			shown: ['d', 'g', 'c', 'b', 'e'], hidden: 2,
			six: 0,
			tone: ['attention', 'running', 'done', 'stopped'],
			summary: '許可待ち 1 · 計画の承認待ち 1 · 作業中 1 · 待機 3 · 完了 1',
			waiting: ['d'],
		});
	});

	test('メンバーの 2 行目とやりとりの見出し', () => {
		expect([
			teamMemberLine(member('a', 'running', { activity: 'Read README.md', description: '数える' })),
			teamMemberLine(member('a', 'idle', { description: '数える' })),
			teamMemberLine(member('a', 'waiting', { approvalTool: 'Bash' })),
			teamMemberLine(member('a', 'failed', { failure: '上限に達しました' })),
			teamMemberLine(member('a', 'running', { backend: 'tmux' })),
			teamMemberLine(member('a', 'idle', { backend: 'iterm2' })),
			teamMessageHeadline({ id: 'm', from: 'a', to: 'b', kind: 'message', text: '\n  一行目\n二行目', at: 0 }),
			teamMessageHeadline({ id: 'm', from: 'a', to: 'b', kind: 'message', summary: '要約', text: '本文', at: 0 }),
			teamMessageHeadline({ id: 'm', from: 'a', to: 'b', kind: 'plan', text: '1. 読む', at: 0 }),
		]).toEqual([
			'Read README.md', '数える', 'Bash の許可を待っています', '上限に達しました', '別のペインで動いています', '別のペイン（iTerm2）で動いています',
			'一行目', '要約', '計画',
		]);
	});
});
