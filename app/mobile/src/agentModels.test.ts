// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { agentModelOptions, claudeModelDisplayName, claudeModelOptionsFromAgents, matchAgentModel } from './agentModels.js';
import type { WorktreeAgentDef } from './store.js';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** PC がインストール済みの Claude Code（2.1.283）から一覧を取れたときに配る Claude の定義（縮めたもの）。 */
const PC_AGENTS: WorktreeAgentDef[] = [
	{
		id: 'claude', label: 'Claude Code',
		efforts: EFFORTS.map(id => ({ id, flag: `--effort ${id}` })),
		models: [
			{ id: 'opus', label: 'opus (Opus 5.5)', resolvedModel: 'claude-opus-5-5', flag: '--model opus', efforts: EFFORTS },
			{ id: 'claude-fable-5-1', label: 'claude-fable-5-1 (Fable 5.1)', resolvedModel: 'claude-fable-5-1', flag: '--model claude-fable-5-1', efforts: EFFORTS },
			{ id: 'claude-opus-5', label: 'claude-opus-5 (Opus 5)', resolvedModel: 'claude-opus-5', flag: '--model claude-opus-5', efforts: EFFORTS },
			{ id: 'haiku', label: 'haiku (Haiku 4.5)', resolvedModel: 'claude-haiku-4-5-20251001', flag: '--model haiku', efforts: [] },
			{ id: 'opusplan', label: 'opusplan', flag: '--model opusplan', efforts: EFFORTS },
		],
	},
	{ id: 'codex', label: 'Codex' },
];

const summary = (options: ReturnType<typeof agentModelOptions>) => options.map(option => `${option.id}|${option.label}|${option.aliases.join(',')}|${option.efforts.length}`);

describe('Claude のモデル候補', () => {
	test('固定表は今の別名の指す先で、Haiku 5.5 も effort を持つ', () => {
		expect(summary(agentModelOptions('claude'))).toEqual([
			'fable|Fable 5.1|claude-fable-5-1|5',
			'opus|Opus 5.5|claude-opus-5-5|5',
			'sonnet|Sonnet 5.5|claude-sonnet-5-5|5',
			'haiku|Haiku 5.5|claude-haiku-5-5|5',
		]);
		expect(agentModelOptions('codex')).toEqual([]);
	});

	test('PC の一覧は正式IDが付いているときだけ使い、ラベルは括弧の中を名前にする', () => {
		const fromPc = claudeModelOptionsFromAgents(PC_AGENTS);
		const oldPc = claudeModelOptionsFromAgents([{ id: 'claude', label: 'Claude Code', models: [{ id: 'opus', label: 'opus (Opus 5)', flag: '--model opus' }] }]);
		expect({ fromPc: fromPc && summary(fromPc), oldPc, none: claudeModelOptionsFromAgents(undefined), empty: agentModelOptions('claude', []).length }).toEqual({
			fromPc: [
				'opus|Opus 5.5|claude-opus-5-5|5',
				'claude-fable-5-1|Fable 5.1|claude-fable-5-1|5',
				'claude-opus-5|Opus 5|claude-opus-5|5',
				'haiku|Haiku 4.5|claude-haiku-4-5-20251001|0',
				'opusplan|opusplan||5',
			],
			oldPc: undefined,
			none: undefined,
			empty: 4,
		});
	});

	test('動いているモデルは完全一致で照合し、claude-opus-5-5 を Opus 5 と取り違えない', () => {
		const pcOptions = claudeModelOptionsFromAgents(PC_AGENTS) ?? [];
		const match = (model: string | undefined, options = agentModelOptions('claude')) => matchAgentModel('claude', model, options)?.label;
		expect({
			fixed: ['claude-opus-5-5', 'claude-fable-5-1', 'claude-haiku-5-5', 'claude-opus-5', 'claude-fable-5', 'opus', 'claude-opus-5-5[1m]', undefined].map(model => match(model)),
			pc: ['claude-opus-5-5', 'claude-opus-5', 'claude-haiku-4-5-20251001', 'claude-fable-5-1'].map(model => match(model, pcOptions)),
			names: ['claude-opus-5-5', 'claude-fable-5', 'claude-haiku-4-5-20251001', 'gpt-5.5'].map(claudeModelDisplayName),
		}).toEqual({
			fixed: ['Opus 5.5', 'Fable 5.1', 'Haiku 5.5', undefined, undefined, 'Opus 5.5', 'Opus 5.5', undefined],
			pc: ['Opus 5.5', 'Opus 5', 'Haiku 4.5', 'Fable 5.1'],
			names: ['Opus 5.5', 'Fable 5', 'Haiku 4.5', undefined],
		});
	});
});
