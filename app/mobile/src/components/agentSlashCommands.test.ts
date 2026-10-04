import { describe, expect, it } from 'vitest';
import { agentSlashCommandOriginLabel, agentSlashQuery, duplicateAgentSlashCommandNames, filterAgentSlashCommands, normalizeAgentSlashSubmission, selectedAgentSlashCommandText, type AgentSlashCommand } from './agentSlashCommands.js';

const commands: AgentSlashCommand[] = [
	{ name: 'aivis', insertText: '/aivis', description: '音声報告', kind: 'skill', source: 'user' },
	{ name: 'agents', insertText: '/agents', description: 'エージェント管理', kind: 'command', source: 'built-in' },
	{ name: 'approve', insertText: '/approve', description: '承認', kind: 'command', source: 'built-in' },
	{ name: 'model', insertText: '/model', description: 'モデル選択', kind: 'command', source: 'built-in' },
];

describe('agentSlashQuery', () => {
	it.each([
		['/', ''],
		['/a', 'a'],
		['/AIVIS', 'AIVIS'],
	])('detects a leading slash token in %s', (text, expected) => {
		expect(agentSlashQuery(text)).toBe(expected);
	});

	it.each(['', 'hello /a', '/a ', '/a\n', '//a'])('does not open for %j', text => {
		expect(agentSlashQuery(text)).toBeUndefined();
	});
});

describe('filterAgentSlashCommands', () => {
	it('filters by a case-insensitive prefix without reordering results', () => {
		expect(filterAgentSlashCommands(commands, 'A', 8).map(command => command.name)).toEqual(['aivis', 'agents', 'approve']);
	});

	it('limits visible results', () => {
		expect(filterAgentSlashCommands(commands, '', 2).map(command => command.name)).toEqual(['aivis', 'agents']);
	});
});

describe('slash command selection and submission', () => {
	it('inserts the mobile-facing slash text', () => {
		expect(selectedAgentSlashCommandText(commands[0]!)).toBe('/aivis');
	});

	it('translates a catalog-verified Codex skill only when it leads the message', () => {
		expect(normalizeAgentSlashSubmission('/aivis 変更を報告', 'codex', commands)).toBe('$aivis 変更を報告');
		expect(normalizeAgentSlashSubmission('/AIVIS 変更を報告', 'codex', commands)).toBe('$aivis 変更を報告');
		expect(normalizeAgentSlashSubmission('/agents', 'codex', commands)).toBe('/agents');
		expect(normalizeAgentSlashSubmission('/unknown arg', 'codex', commands)).toBe('/unknown arg');
		expect(normalizeAgentSlashSubmission('説明 /aivis', 'codex', commands)).toBe('説明 /aivis');
		expect(normalizeAgentSlashSubmission('/aivis', 'claude', commands)).toBe('/aivis');
	});
});

describe('agentSlashCommandOriginLabel', () => {
	it('labels only the names that appear twice, by where each one comes from', () => {
		const listed: AgentSlashCommand[] = [
			{ name: 'context', insertText: '/context', description: '', kind: 'command', source: 'project' },
			{ name: 'codex:rescue', insertText: '/codex:rescue', description: '', kind: 'command', source: 'plugin', plugin: 'codex' },
			{ name: 'Context', insertText: '/Context', description: '', kind: 'command', source: 'built-in' },
		];
		expect({
			duplicates: [...duplicateAgentSlashCommandNames(listed)],
			labels: listed.map(agentSlashCommandOriginLabel),
			mcp: agentSlashCommandOriginLabel({ ...listed[0]!, source: 'mcp' }),
		}).toEqual({ duplicates: ['context'], labels: ['自作', 'codex', '組み込み'], mcp: 'MCP' });
	});
});
