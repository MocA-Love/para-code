// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { nextPcAgentSources, summarizeAgentCounts, type PcAgentSourceInput } from './pcAgentSources.js';

type Workspace = NonNullable<PcAgentSourceInput['workspace']>;

const terminal = (terminalKey: string, agentStatus: string | undefined, agent = true) => ({
	terminalKey, id: 1, windowId: 1, rendererGeneration: 1, title: terminalKey, agent, ...(agentStatus !== undefined ? { agentStatus } : {}),
});

describe('PC ごとの件数（summarizeRuntime の件数の部分）', () => {
	test('要対応はアーカイブを見ず、実行中はアーカイブとプレーンなターミナルを除く', () => {
		const terminals = [
			terminal('a', 'working'), terminal('b', 'working'), terminal('c', 'permission'), terminal('d', 'question'),
			terminal('e', 'working', false), terminal('f', 'review'),
		];
		expect([summarizeAgentCounts(terminals, ['b', 'c']), summarizeAgentCounts(undefined, [])]).toEqual([
			{ terminals: 6, waiting: 2, running: 1 },
			{ terminals: 0, waiting: 0, running: 0 },
		]);
	});
});

describe('PC ごとの行の元の配り直し', () => {
	const ws = (terminals: Workspace['terminals']): Workspace => ({ terminals, workspaces: [{ id: 'w1', sourceId: 's', windowId: 1, name: 'api' }], activeWs: 'w1' });
	const archived: readonly string[] = [];
	const wa = ws([terminal('a', 'working')]);
	const wb = ws([terminal('b', 'permission')]);
	const first = nextPcAgentSources({}, [{ id: 'a', workspace: wa, archived }, { id: 'b', workspace: wb, archived }, { id: 'c', workspace: undefined, archived }]);

	test('参照がどれも同じなら前回の入れ物をそのまま返す（配り直さない）', () => {
		expect(nextPcAgentSources(first, [{ id: 'a', workspace: wa, archived }, { id: 'b', workspace: wb, archived }, { id: 'c', workspace: undefined, archived }])).toBe(first);
	});

	test('変わった PC だけ作り直し、変わっていない PC は前回の元を使い回す。State の無い PC は入れない', () => {
		const wb2 = ws([terminal('b', 'working')]);
		const next = nextPcAgentSources(first, [{ id: 'a', workspace: wa, archived }, { id: 'b', workspace: wb2, archived }, { id: 'c', workspace: undefined, archived }]);
		expect({ keys: Object.keys(next), sameA: next['a'] === first['a'], sameB: next['b'] === first['b'], bTerminals: next['b']?.terminals === wb2.terminals })
			.toEqual({ keys: ['a', 'b'], sameA: true, sameB: false, bTerminals: true });
	});

	test('アーカイブの印・PC の増減も配り直す', () => {
		const archivedA = nextPcAgentSources(first, [{ id: 'a', workspace: wa, archived: ['a'] }, { id: 'b', workspace: wb, archived }]);
		const removed = nextPcAgentSources(first, [{ id: 'a', workspace: wa, archived }]);
		expect({ archived: archivedA !== first && archivedA['a']?.archived, removed: Object.keys(removed) }).toEqual({ archived: ['a'], removed: ['a'] });
	});
});
