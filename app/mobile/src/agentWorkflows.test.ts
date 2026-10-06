// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import type { AgentShell } from './agentShells.js';
import {
	formatWorkflowDuration, formatWorkflowTokens, localizeAgentWorkflows, paneShells, parseAgentWorkflows, splitWorkflowAgents, workflowAgentMeta,
	workflowChips, workflowForToolUse, workflowPhaseViews, workflowShellsByAgent, workflowTone,
	type AgentWorkflow, type AgentWorkflowAgent,
} from './agentWorkflows.js';

const NOW = 1_760_000_100_000;

function agent(id: string, overrides: Partial<AgentWorkflowAgent> = {}): AgentWorkflowAgent {
	return { id, label: `l:${id}`, phase: 0, state: 'done', ...overrides };
}

function workflow(overrides: Partial<AgentWorkflow> = {}): AgentWorkflow {
	const agents = overrides.agents ?? [agent('a1'), agent('a2', { phase: 1, state: 'running', startedAt: NOW - 120_000, lastTool: 'Grep' })];
	return {
		runId: 'wf_1', toolUseId: 'toolu_1', name: 'audit', status: 'running', startedAt: NOW - 38 * 60_000,
		phases: [{ title: 'Find' }, { title: 'Verify' }, { title: 'Report' }],
		agents, agentCount: agents.length,
		counts: { running: agents.filter(item => item.state === 'running').length, done: agents.filter(item => item.state === 'done').length, failed: agents.filter(item => item.state === 'failed').length, stopped: agents.filter(item => item.state === 'stopped').length },
		...overrides,
	};
}

describe('Workflow のカード（agent.workflows.v1）', () => {
	it('PC の値を読み、形の合わない要素と範囲外の段階を捨て、時刻を手元の時計へ直す', () => {
		const parsed = parseAgentWorkflows([
			{ runId: 'wf_1', status: 'completed', startedAt: 1000, endedAt: 5000, name: 'n', phases: [{ title: 'A' }, { detail: 'no title' }], agents: [{ id: 'a1', state: 'done', phase: 0, startedAt: 1500 }, { id: 'a2', state: 'weird' }, { id: 'a3', state: 'failed', phase: 9 }], agentCount: 40, counts: { running: 0, done: 39, failed: 1, stopped: 0 } },
			{ runId: '../x', status: 'running', startedAt: 1 },
			{ runId: 'wf_2', status: 'paused', startedAt: 1 },
			'garbage',
		]);
		expect({
			parsed,
			missing: parseAgentWorkflows(undefined),
			localized: localizeAgentWorkflows(parsed ?? [], 10_000, 10_500).map(item => [item.startedAt, item.endedAt, item.agents[0]?.startedAt]),
		}).toEqual({
			parsed: [{
				runId: 'wf_1', name: 'n', status: 'completed', startedAt: 1000, endedAt: 5000, phases: [{ title: 'A' }],
				agents: [{ id: 'a1', state: 'done', phase: 0, startedAt: 1500 }, { id: 'a3', state: 'failed' }],
				agentCount: 40, counts: { running: 0, done: 39, failed: 1, stopped: 0 },
			}],
			missing: undefined,
			localized: [[1500, 5500, 2000]],
		});
	});

	it('状態・段階・チップ: 完了でも失敗した子がいれば一部失敗、実行中はトークンを出さない', () => {
		const running = workflow();
		const partial = workflow({ status: 'completed', durationMs: 80 * 60_000, totalTokens: 9_100_000, totalToolCalls: 3361, agents: [agent('a1'), agent('a2', { phase: 1, state: 'failed' })] });
		const views = workflowPhaseViews(running);
		expect({
			tones: [workflowTone(running), workflowTone(partial), workflowTone(workflow({ status: 'failed' })), workflowTone(workflow({ status: 'stopped' }))],
			phases: views.phases.map(phase => [phase.title, phase.tone, phase.agents.length]),
			current: views.current,
			runningChips: workflowChips(running, NOW, 2).map(chip => chip.text),
			partialChips: workflowChips(partial, NOW, 0).map(chip => [chip.text, chip.tone]),
		}).toEqual({
			tones: ['running', 'partial', 'failed', 'stopped'],
			phases: [['Find', 'done', 1], ['Verify', 'running', 1], ['Report', 'pending', 0]],
			current: 1,
			runningChips: ['段階 2/3 Verify', '子 2（実行中 1）', '38分', 'シェル 2'],
			partialChips: [['段階 2/3 Verify', undefined], ['子 2', undefined], ['失敗 1', 'red'], ['9.1M tokens', undefined], ['ツール 3,361', undefined], ['1時間20分', undefined]],
		});
	});

	it('段階の分からない子は「その他」へ入れ、段階の無い Workflow は「子」1 つにまとめる', () => {
		const loose = workflow({ agents: [agent('a1'), agent('a9', { phase: undefined })] });
		const flat = workflow({ phases: [], agents: [agent('a1', { phase: undefined })] });
		expect({
			loose: workflowPhaseViews(loose).phases.map(phase => [phase.title, phase.agents.map(item => item.id)]),
			flat: workflowPhaseViews(flat).phases.map(phase => [phase.title, phase.agents.map(item => item.id)]),
			flatChips: workflowChips(flat, NOW, 0).map(chip => chip.key),
		}).toEqual({
			loose: [['Find', ['a1']], ['Verify', []], ['Report', []], ['その他', ['a9']]],
			flat: [['子', ['a1']]],
			flatChips: ['agents', 'elapsed'],
		});
	});

	it('完了した子は畳み、失敗・実行中・中断の順に開いて見せる（Q260 A）', () => {
		const { open, done } = splitWorkflowAgents([agent('d1'), agent('r1', { state: 'running' }), agent('s1', { state: 'stopped' }), agent('f1', { state: 'failed' }), agent('r2', { state: 'running' })]);
		expect({ open: open.map(item => item.id), done: done.map(item => item.id) }).toEqual({ open: ['f1', 'r1', 'r2', 's1'], done: ['d1'] });
	});

	it('Workflow の子のシェルはカードへ寄せ、ペインの一覧からは外す（Q259 A）。古い PC なら全部残す', () => {
		const shells: AgentShell[] = [
			{ id: 'bparent', startedAt: NOW, status: 'running' },
			{ id: 'bwf', startedAt: NOW, status: 'running', ownerAgentId: 'a2', description: 'npm test' },
			{ id: 'bsub', startedAt: NOW, status: 'running', ownerAgentId: 'aplain' },
		];
		const target = workflow();
		const byAgent = workflowShellsByAgent(target, shells);
		expect({
			byAgent: [...byAgent.entries()].map(([id, list]) => [id, list.map(shell => shell.id)]),
			pane: paneShells(shells, [target])?.map(shell => shell.id),
			oldPc: paneShells(shells, undefined)?.map(shell => shell.id),
			meta: workflowAgentMeta(target.agents[1]!, NOW, byAgent.get('a2')),
			found: workflowForToolUse([target], 'toolu_1')?.runId,
			notFound: workflowForToolUse([target], 'toolu_x'),
		}).toEqual({
			byAgent: [['a2', ['bwf']]],
			pane: ['bparent', 'bsub'],
			oldPc: ['bparent', 'bwf', 'bsub'],
			meta: '2分 · 最後: Grep · シェル: npm test',
			found: 'wf_1',
			notFound: undefined,
		});
	});

	it('経過とトークンの書き方', () => {
		expect([formatWorkflowDuration(42_000), formatWorkflowDuration(38 * 60_000), formatWorkflowDuration(120 * 60_000), formatWorkflowTokens(38_452), formatWorkflowTokens(910_000), formatWorkflowTokens(4_200_000)])
			.toEqual(['42秒', '38分', '2時間', '38k', '910k', '4.2M']);
	});
});
