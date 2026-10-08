// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { countAttentionAgents, countRunningAgents, isAttentionAgent } from './attentionCount.js';

describe('countAttentionAgents', () => {
	test('許可待ちと質問のエージェントだけを数える', () => {
		expect(countAttentionAgents([
			{ agent: true, agentStatus: 'permission' },
			{ agent: true, agentStatus: 'question' },
			{ agent: true, agentStatus: 'working' },
			{ agent: true, agentStatus: 'review' },
			{ agent: true, agentStatus: undefined },
		])).toBe(2);
	});

	test('エージェントの実績が無いターミナルは状態が要対応でも数えない（ホームの一覧に出ないため）', () => {
		expect(countAttentionAgents([
			{ agent: false, agentStatus: 'permission' },
			{ agentStatus: 'question' },
		])).toBe(0);
	});

	test('スペースの違いは見ない（ホームの絞り込み中もタブのバッジと同じ数になる）', () => {
		const terminals = [
			{ agent: true, agentStatus: 'permission', ws: 'w1' },
			{ agent: true, agentStatus: 'question', ws: 'w2' },
		];
		expect(countAttentionAgents(terminals)).toBe(2);
	});

	test('一覧が届いていなければ 0', () => {
		expect(countAttentionAgents(undefined)).toBe(0);
		expect(countAttentionAgents([])).toBe(0);
	});

	test('件数と、スタックに積む行の判定が一致する', () => {
		const terminals = [
			{ agent: true, agentStatus: 'permission' },
			{ agent: false, agentStatus: 'permission' },
			{ agent: true, agentStatus: 'working' },
		];
		expect(terminals.filter(isAttentionAgent)).toHaveLength(countAttentionAgents(terminals));
	});
});

describe('countRunningAgents', () => {
	const terminals = [
		{ terminalKey: 'a', agent: true, agentStatus: 'working' },
		{ terminalKey: 'b', agent: true, agentStatus: 'working' },
		{ terminalKey: 'c', agent: false, agentStatus: 'working' },
		{ terminalKey: 'd', agent: true, agentStatus: 'review' },
		{ terminalKey: 'e', agent: true, agentStatus: 'permission' },
	];

	test('エージェントの working だけを数え、アーカイブしたものは数えない（保存形の配列と Set のどちらでも）', () => {
		expect([
			countRunningAgents(terminals, []),
			countRunningAgents(terminals, ['b']),
			countRunningAgents(terminals, new Set(['a', 'b'])),
			countRunningAgents(undefined, []),
		]).toEqual([2, 1, 0, 0]);
	});
});
